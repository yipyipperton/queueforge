"use client";
import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = D.Root;
export const SheetTitle = D.Title;
export const SheetDescription = D.Description;
export function SheetContent({ className, children, ...p }: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <D.Content
        className={cn("fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-[#0e1014] shadow-2xl outline-none data-[state=open]:animate-[slide-in_200ms_cubic-bezier(0.2,0.8,0.2,1)]", className)}
        {...p}
      >
        {children}
        <D.Close className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close"><X className="size-4" /></D.Close>
      </D.Content>
    </D.Portal>
  );
}
