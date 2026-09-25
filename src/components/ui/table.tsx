import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Dense data tables.
 *
 * No zebra striping: alternating grounds fight the status chips for attention
 * and make a scan slower, not faster. Rows separate on a hairline and light up
 * one at a time under the cursor, which is the only row an operator cares
 * about at any moment.
 */

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** The scroll container, not the table - tables are the one thing allowed
      to be wider than the page. */
  containerClassName?: string;
}

export function Table({ className, containerClassName, ...props }: TableProps) {
  return (
    <div className={cn("w-full overflow-x-auto", containerClassName)}>
      <table
        className={cn("w-full border-collapse text-left text-sm", className)}
        {...props}
      />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "border-b border-subtle",
        // Header rows are not hoverable; cancel the row style from here rather
        // than making every caller remember a prop.
        "[&_tr]:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-subtle", className)} {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "transition-colors duration-[var(--dur-press)] ease-[var(--ease-out)] hover:bg-raised",
        className,
      )}
      {...props}
    />
  );
}

export interface CellProps {
  /** Right-aligns and switches to lining monospace digits. */
  numeric?: boolean;
}

export function TH({
  numeric,
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 px-3 align-middle text-2xs font-medium whitespace-nowrap text-faint uppercase",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  numeric,
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      className={cn(
        "px-3 py-3 align-middle text-fg",
        numeric && "text-right font-mono tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
