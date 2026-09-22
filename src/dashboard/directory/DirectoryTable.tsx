import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useMemo } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import type { ThreadContact } from "../../domain/contact";
import type { DirectoryColumnsOptions } from "./columns";
import { createDirectoryColumns } from "./columns";

export interface DirectoryTableProps extends DirectoryColumnsOptions {
  contacts: ThreadContact[];
}

/**
 * Fixed proportions rather than content-driven widths: a single long note,
 * handle or URL used to widen its column and push the table into horizontal
 * scrolling. The `<colgroup>` below is the only place the split lives, and
 * the per-column classes say how each one copes with the width it gets -
 * clip with an ellipsis (the three text columns), or wrap (date, actions).
 * Actions must never be clipped, so it wraps instead.
 */
const COLUMNS: Record<string, { width: string; className: string }> = {
  nickname: { width: "24%", className: "overflow-hidden" },
  username: { width: "20%", className: "overflow-hidden" },
  note: { width: "26%", className: "overflow-hidden" },
  updatedAt: { width: "20%", className: "whitespace-normal" },
  actions: { width: "10%", className: "whitespace-normal text-right" },
};

export function DirectoryTable({ contacts, pendingConflictByContactId, onEdit, onResolveConflict }: DirectoryTableProps) {
  // Built once per change of its inputs, not on every render: a cell renderer that is a new function each time is a
  // new component type to React, so every button in every row was thrown away and rebuilt whenever the page
  // re-rendered (opening the editor, typing in the search box). That cost the work, and it took keyboard focus
  // away from the button the person had pressed.
  const columns = useMemo(
    () => createDirectoryColumns({ pendingConflictByContactId, onEdit, onResolveConflict }),
    [pendingConflictByContactId, onEdit, onResolveConflict],
  );
  const table = useReactTable({
    data: contacts,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (contact) => contact.id,
  });

  return (
    <Table className="table-fixed">
      <colgroup>
        {table.getAllLeafColumns().map((column) => (
          <col key={column.id} style={{ width: COLUMNS[column.id]?.width }} />
        ))}
      </colgroup>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} className={COLUMNS[header.column.id]?.className}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} className="h-12">
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className={COLUMNS[cell.column.id]?.className}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
