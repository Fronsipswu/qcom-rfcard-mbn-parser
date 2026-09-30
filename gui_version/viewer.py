from __future__ import annotations

import csv
import sys
import tkinter as tk
import tkinter.font as tkfont
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any, Sequence

try:
    import qualcomm_rf_combo_analyzer as analyzer
except ImportError:
    from gui_version import qualcomm_rf_combo_analyzer as analyzer


class ComboViewerWindow(tk.Toplevel):
    """Interactive pop-up window to view and search Qualcomm RF combinations."""

    TAB_DEFINITIONS = (
        ("LTE", "lte_ca"),
        ("NRCA", "nr_ca"),
        ("ENDC", "endc"),
        ("NRDC", "nrdc"),
    )

    def s(self, px: int) -> int:
        """Scale pixel value by display scale factor."""
        return max(1, round(px * self.scale))

    def __init__(
        self,
        parent: tk.Tk | tk.Toplevel,
        record: Any = None,
        parsed: dict[str, Any] | None = None,
        source: Path | None = None,
        scale: float = 1.0,
        title_suffix: str = "",
    ) -> None:
        super().__init__(parent)
        self.parent = parent
        self.scale = scale
        self.record = record
        self.source = source

        # Window configuration
        card_id = getattr(record, "identity", None) or getattr(record, "name", "RF Card")
        self.title(f"RF Combo Viewer - {card_id}{title_suffix}")
        win_w = self.s(1120)
        win_h = self.s(700)
        self.geometry(f"{win_w}x{win_h}")
        self.minsize(self.s(850), self.s(450))

        # Build table data
        self.raw_tables: dict[str, list[dict[str, Any]]] = {}
        if parsed is not None:
            self.raw_tables = analyzer.generate_web_tables(
                parsed.get("combinations", []),
                parsed.get("components", []),
            )

        # Tab data tracking: tab_key -> {"columns": [...], "rows": [...], "tree": Treeview, "sort_state": (col, reverse)}
        self.tabs_data: dict[str, dict[str, Any]] = {}
        self.active_tab_key: str | None = None

        # Filter state
        self.search_var = tk.StringVar(value="")
        self.count_var = tk.StringVar(value="")

        self._build_ui()
        self._populate_tabs()

        # Keyboard shortcuts
        self.bind("<Control-f>", lambda _: self.search_entry.focus_set())
        self.bind("<Escape>", lambda _: self.clear_search())
        self.bind("<Control-c>", lambda _: self.copy_selected())

    def _build_ui(self) -> None:
        outer = ttk.Frame(self, padding=self.s(10))
        outer.pack(fill="both", expand=True)

        # Header Info Banner
        header = ttk.Frame(outer)
        header.pack(fill="x", pady=(0, self.s(8)))

        info_parts = []
        if self.record:
            if getattr(self.record, "identity", None):
                info_parts.append(f"HWID_FSID_BID: {self.record.identity}")
            gen = getattr(self.record, "generation", None)
            if gen:
                info_parts.append(f"Format: {gen}")
            size = getattr(self.record, "size", 0)
            if size:
                info_parts.append(f"Size: {size / 1024:,.1f} KB")
            inner_path = getattr(self.record, "inner_path", None)
            if inner_path:
                info_parts.append(f"Path: {inner_path}")

        info_text = "  |  ".join(info_parts) if info_parts else "RF Card Combination Viewer"
        info_label = ttk.Label(header, text=info_text, font=("TkDefaultFont", 9, "bold"))
        info_label.pack(side="left", fill="x", expand=True)

        # Search Bar Frame
        search_frame = ttk.Frame(outer)
        search_frame.pack(fill="x", pady=(0, self.s(8)))

        ttk.Label(search_frame, text="Search:").pack(side="left", padx=(0, self.s(6)))
        self.search_entry = ttk.Entry(
            search_frame,
            textvariable=self.search_var,
            width=36,
        )
        self.search_entry.pack(side="left", padx=(0, self.s(4)))
        self.search_entry.focus_set()

        clear_btn = ttk.Button(
            search_frame,
            text="✕",
            width=3,
            command=self.clear_search,
        )
        clear_btn.pack(side="left", padx=(0, self.s(12)))

        self.show_scs_var = tk.BooleanVar(value=False)
        self.show_scs_check = ttk.Checkbutton(
            search_frame,
            text="Show SCS",
            variable=self.show_scs_var,
            command=self._on_scs_toggle,
        )
        self.show_scs_check.pack(side="left", padx=(0, self.s(14)))

        self.count_label = ttk.Label(
            search_frame,
            textvariable=self.count_var,
            foreground="#555555",
        )
        self.count_label.pack(side="left", padx=(0, self.s(12)))

        # Live search filtering trigger
        self.search_var.trace_add("write", lambda *_: self.apply_filter())

        # Notebook tabs
        self.notebook = ttk.Notebook(outer)
        self.notebook.pack(fill="both", expand=True)
        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

    def _update_visible_columns(self, tbl_key: str) -> None:
        """Update visible columns for a tab based on SCS toggle."""
        info = self.tabs_data.get(tbl_key)
        if not info:
            return
        tree: ttk.Treeview = info["tree"]
        columns = info["columns"]
        show_scs = self.show_scs_var.get()

        if show_scs:
            tree.configure(displaycolumns="#all")
        else:
            display_cols = [c for c in columns if "SCS" not in c]
            tree.configure(displaycolumns=display_cols)

    def _on_scs_toggle(self) -> None:
        """Handle Show SCS toggle across all tabs."""
        for tbl_key in self.tabs_data:
            self._update_visible_columns(tbl_key)

    def _populate_tabs(self) -> None:
        """Create tabs for available tables and populate them with combination data."""
        # Fonts for measuring auto-fit column widths
        self.cell_font = tkfont.Font(font=("TkFixedFont", max(8, self.s(9))))
        self.header_font = tkfont.nametofont("TkDefaultFont")

        # Row zebra-striping tag styles
        style = ttk.Style(self)
        style.configure("Viewer.Treeview", font=self.cell_font)
        style.map("Viewer.Treeview", background=[("selected", "#0078D7")], foreground=[("selected", "#FFFFFF")])

        created_tabs = 0
        for tab_label, tbl_key in self.TAB_DEFINITIONS:
            rows = self.raw_tables.get(tbl_key, [])
            if not rows:
                continue

            columns = list(rows[0].keys())

            tab_frame = ttk.Frame(self.notebook, padding=self.s(2))
            tab_frame.rowconfigure(0, weight=1)
            tab_frame.columnconfigure(0, weight=1)

            tree = ttk.Treeview(
                tab_frame,
                columns=columns,
                show="headings",
                selectmode="extended",
                style="Viewer.Treeview",
            )
            tree.tag_configure("oddrow", background="#F7F9FA")
            tree.tag_configure("evenrow", background="#FFFFFF")

            # Column headings and auto-adjusted content widths
            for col in columns:
                # Measure header width including space for sort indicator
                header_w = self.header_font.measure(f"{col} ▲")

                # Measure actual longest text values in this column
                longest_vals = sorted(
                    (str(r.get(col, "")) for r in rows),
                    key=len,
                    reverse=True,
                )[:5]
                content_w = max([self.cell_font.measure(v) for v in longest_vals], default=0)

                # Fit to the widest content with comfortable padding
                col_width = max(self.s(45), max(header_w, content_w) + self.s(16))

                tree.heading(
                    col,
                    text=col,
                    command=lambda c=col, tk_key=tbl_key: self.sort_column(tk_key, c),
                )
                tree.column(
                    col,
                    width=col_width,
                    minwidth=self.s(40),
                    anchor="center",
                    stretch=False,
                )

            y_scroll = ttk.Scrollbar(tab_frame, orient="vertical", command=tree.yview)
            x_scroll = ttk.Scrollbar(tab_frame, orient="horizontal", command=tree.xview)
            tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

            tree.grid(row=0, column=0, sticky="nsew")
            y_scroll.grid(row=0, column=1, sticky="ns")
            x_scroll.grid(row=1, column=0, sticky="ew")

            # Right click context menu
            tree.bind("<Button-3>", lambda e, tr=tree: self._show_context_menu(e, tr))

            self.tabs_data[tbl_key] = {
                "label": tab_label,
                "columns": columns,
                "rows": rows,
                "filtered_rows": list(rows),
                "tree": tree,
                "sort_col": None,
                "sort_reverse": False,
            }

            # Apply initial column visibility (hide SCS by default)
            self._update_visible_columns(tbl_key)

            self.notebook.add(tab_frame, text=f"{tab_label} ({len(rows)})")
            created_tabs += 1

            # Populate initial rows
            self._insert_rows(tbl_key, rows)

        if created_tabs == 0:
            empty_frame = ttk.Frame(self.notebook, padding=self.s(20))
            ttk.Label(
                empty_frame,
                text="No combinations found for this RF card.",
                font=("TkDefaultFont", 11),
            ).pack(expand=True)
            self.notebook.add(empty_frame, text="Empty")
            self.count_var.set("0 combos")

    def _insert_rows(self, tbl_key: str, rows: Sequence[dict[str, Any]]) -> None:
        """Insert rows into a tab's Treeview."""
        info = self.tabs_data[tbl_key]
        tree: ttk.Treeview = info["tree"]
        columns = info["columns"]

        tree.delete(*tree.get_children())
        for idx, row in enumerate(rows):
            values = tuple(row.get(col, "") for col in columns)
            tag = "evenrow" if idx % 2 == 0 else "oddrow"
            tree.insert("", "end", iid=str(idx), values=values, tags=(tag,))

    def _on_tab_changed(self, _event: Any = None) -> None:
        selected_id = self.notebook.select()
        if not selected_id:
            return
        selected_idx = self.notebook.index(selected_id)
        active_keys = [k for _, k in self.TAB_DEFINITIONS if k in self.tabs_data]
        if 0 <= selected_idx < len(active_keys):
            self.active_tab_key = active_keys[selected_idx]
            self.apply_filter()

    def clear_search(self) -> None:
        self.search_var.set("")
        self.search_entry.focus_set()

    def apply_filter(self) -> None:
        """Filter the active tab based on the search query."""
        if not self.active_tab_key or self.active_tab_key not in self.tabs_data:
            return

        info = self.tabs_data[self.active_tab_key]
        raw_rows = info["rows"]
        query = self.search_var.get().strip().casefold()

        if not query:
            filtered = list(raw_rows)
        else:
            query_nospace = query.replace(" ", "")
            filtered = []
            for row in raw_rows:
                row_text = " ".join(str(v) for v in row.values()).casefold()
                row_nospace = row_text.replace(" ", "")
                if query in row_text or query_nospace in row_nospace:
                    filtered.append(row)

        info["filtered_rows"] = filtered

        # If a sort was active, re-apply sort
        sort_col = info["sort_col"]
        if sort_col:
            reverse = info["sort_reverse"]
            filtered.sort(key=lambda r: str(r.get(sort_col, "")), reverse=reverse)

        self._insert_rows(self.active_tab_key, filtered)

        total = len(raw_rows)
        shown = len(filtered)
        if query:
            self.count_var.set(f"Showing {shown:,} of {total:,} combos")
        else:
            self.count_var.set(f"Total: {total:,} combos")

    def sort_column(self, tbl_key: str, col: str) -> None:
        """Sort tab rows by the clicked column."""
        info = self.tabs_data.get(tbl_key)
        if not info:
            return

        if info["sort_col"] == col:
            info["sort_reverse"] = not info["sort_reverse"]
        else:
            info["sort_col"] = col
            info["sort_reverse"] = False

        reverse = info["sort_reverse"]
        arrow = " ▼" if reverse else " ▲"

        # Update headings with sort indicator
        tree: ttk.Treeview = info["tree"]
        for c in info["columns"]:
            tree.heading(c, text=f"{c}{arrow}" if c == col else c)

        filtered = info["filtered_rows"]
        # Numeric or natural sort if possible
        def _sort_val(r: dict[str, Any]) -> Any:
            v = str(r.get(col, ""))
            try:
                return (0, int(v))
            except ValueError:
                return (1, v)

        filtered.sort(key=_sort_val, reverse=reverse)
        self._insert_rows(tbl_key, filtered)

    def _show_context_menu(self, event: Any, tree: ttk.Treeview) -> None:
        iid = tree.identify_row(event.y)
        if iid and iid not in tree.selection():
            tree.selection_set(iid)

        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="Copy Selected Row(s)", command=self.copy_selected)
        menu.add_command(label="Copy Carrier Combo Only", command=self.copy_combo_only)
        menu.add_separator()
        menu.add_command(label="Copy All Filtered Rows", command=self.copy_all_visible)
        menu.tk_popup(event.x_root, event.y_root)

    def copy_selected(self) -> None:
        if not self.active_tab_key or self.active_tab_key not in self.tabs_data:
            return
        info = self.tabs_data[self.active_tab_key]
        tree: ttk.Treeview = info["tree"]
        selection = tree.selection()
        if not selection:
            return

        columns = info["columns"]
        lines = ["\t".join(columns)]
        for iid in selection:
            values = tree.item(iid, "values")
            lines.append("\t".join(str(v) for v in values))

        text = "\n".join(lines)
        self.clipboard_clear()
        self.clipboard_append(text)

    def copy_combo_only(self) -> None:
        """Copy just the primary DL combo string of selected rows."""
        if not self.active_tab_key or self.active_tab_key not in self.tabs_data:
            return
        info = self.tabs_data[self.active_tab_key]
        tree: ttk.Treeview = info["tree"]
        selection = tree.selection()
        if not selection:
            return

        # Find DL column name
        columns = info["columns"]
        dl_col_idx = 0
        for idx, col in enumerate(columns):
            if "DL" in col:
                dl_col_idx = idx
                break

        combos = []
        for iid in selection:
            values = tree.item(iid, "values")
            if dl_col_idx < len(values):
                combos.append(str(values[dl_col_idx]))

        text = "\n".join(combos)
        self.clipboard_clear()
        self.clipboard_append(text)

    def copy_all_visible(self) -> None:
        if not self.active_tab_key or self.active_tab_key not in self.tabs_data:
            return
        info = self.tabs_data[self.active_tab_key]
        columns = info["columns"]
        rows = info["filtered_rows"]

        lines = ["\t".join(columns)]
        for r in rows:
            lines.append("\t".join(str(r.get(c, "")) for c in columns))

        text = "\n".join(lines)
        self.clipboard_clear()
        self.clipboard_append(text)

    def export_current_tab_csv(self) -> None:
        """Export the visible rows of the current tab to a CSV file."""
        if not self.active_tab_key or self.active_tab_key not in self.tabs_data:
            return
        info = self.tabs_data[self.active_tab_key]
        label = info["label"]
        rows = info["filtered_rows"]
        if not rows:
            messagebox.showinfo("Export CSV", "No rows to export.")
            return

        default_name = f"{label.lower()}_combos.csv"
        if self.record and getattr(self.record, "identity", None):
            default_name = f"rf_config_{self.record.identity}_{label.lower()}.csv"

        path_str = filedialog.asksaveasfilename(
            parent=self,
            title=f"Export {label} Combinations to CSV",
            initialfile=default_name,
            filetypes=(("CSV files", "*.csv"), ("All files", "*.*")),
        )
        if not path_str:
            return

        target_path = Path(path_str)
        try:
            with target_path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=info["columns"])
                writer.writeheader()
                for r in rows:
                    writer.writerow(r)
            messagebox.showinfo("Export CSV", f"Successfully exported {len(rows):,} rows to:\n{target_path}")
        except Exception as e:
            messagebox.showerror("Export Failed", f"Could not write CSV:\n{e}")


def open_viewer(
    parent: tk.Tk | tk.Toplevel,
    record: Any,
    source: Path | None = None,
    scale: float = 1.0,
) -> ComboViewerWindow | None:
    """Helper to read, parse, and open a ComboViewerWindow for an RF Card record."""
    try:
        blob = analyzer.read_module(source, record)
        parsed = analyzer.parse_module(record, blob)
        return ComboViewerWindow(parent, record=record, parsed=parsed, source=source, scale=scale)
    except Exception as e:
        messagebox.showerror(
            "Viewer Error",
            f"Failed to parse RF card '{getattr(record, 'name', 'unknown')}':\n\n{e}",
        )
        return None


if __name__ == "__main__":
    # Standalone demo / test runner
    root = tk.Tk()
    root.withdraw()

    # Load from test directory if arguments provided
    if len(sys.argv) >= 3:
        combos_path = Path(sys.argv[1])
        comps_path = Path(sys.argv[2])
        with combos_path.open("r", encoding="utf-8-sig") as f:
            combos = list(csv.DictReader(f))
        with comps_path.open("r", encoding="utf-8-sig") as f:
            comps = list(csv.DictReader(f))
        parsed_data = {"combinations": combos, "components": comps}
        dummy_rec = type("DummyRecord", (), {
            "identity": combos_path.stem.replace("_combinations", ""),
            "name": combos_path.name,
            "generation": "XML DAT",
            "size": combos_path.stat().st_size,
            "inner_path": str(combos_path),
        })()
        win = ComboViewerWindow(root, record=dummy_rec, parsed=parsed_data)
        win.protocol("WM_DELETE_WINDOW", root.destroy)
        root.mainloop()
    else:
        print("Usage: python viewer.py <combinations.csv> <components.csv>")
