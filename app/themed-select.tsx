"use client";

import { useEffect, useId, useRef, useState } from "react";
import { reduceThemedSelectKey } from "@/lib/themed-select-state";

export type ThemedSelectOption = { value: string; label: string; disabled?: boolean };

type ThemedSelectProps = {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
};

export default function ThemedSelect({ value, options, onChange, disabled = false, className = "", ...ariaProps }: ThemedSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => setActiveIndex(selectedIndex), [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function selectIndex(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`themed-select ${className}`.trim()}>
      <button
        type="button"
        className="themed-select-trigger"
        disabled={disabled || options.length === 0}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        {...ariaProps}
        onClick={() => {
          if (!disabled) {
            setActiveIndex(selectedIndex);
            setOpen((current) => !current);
          }
        }}
        onKeyDown={(event) => {
          const next = reduceThemedSelectKey({ key: event.key, open, activeIndex, selectedIndex, options });
          if (next.handled) {
            event.preventDefault();
            setActiveIndex(next.activeIndex);
            setOpen(next.open);
            if (next.selectIndex != null) selectIndex(next.selectIndex);
          }
        }}
      >
        <span>{selected?.label ?? "Select an option"}</span>
        <span className="themed-select-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <ul className="themed-select-menu" id={listboxId} role="listbox" aria-label={ariaProps["aria-label"]}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`themed-select-option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectIndex(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
