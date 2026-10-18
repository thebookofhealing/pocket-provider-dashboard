export type ThemedSelectStateOption = { disabled?: boolean };

export type ThemedSelectKeyResult = {
  handled: boolean;
  open: boolean;
  activeIndex: number;
  selectIndex?: number;
};

function enabledIndexes(options: readonly ThemedSelectStateOption[]): number[] {
  return options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
}

export function nextThemedSelectIndex(options: readonly ThemedSelectStateOption[], activeIndex: number, direction: 1 | -1): number {
  const enabled = enabledIndexes(options);
  if (enabled.length === 0) return activeIndex;
  const position = Math.max(0, enabled.indexOf(activeIndex));
  return enabled[(position + direction + enabled.length) % enabled.length] ?? activeIndex;
}

export function reduceThemedSelectKey({
  key,
  open,
  activeIndex,
  selectedIndex,
  options
}: {
  key: string;
  open: boolean;
  activeIndex: number;
  selectedIndex: number;
  options: readonly ThemedSelectStateOption[];
}): ThemedSelectKeyResult {
  if (key === "ArrowDown" || key === "ArrowUp") {
    return {
      handled: true,
      open: true,
      activeIndex: nextThemedSelectIndex(options, open ? activeIndex : selectedIndex, key === "ArrowDown" ? 1 : -1)
    };
  }
  if ((key === "Enter" || key === " ") && open) {
    const option = options[activeIndex];
    return { handled: true, open: false, activeIndex, selectIndex: option?.disabled ? undefined : activeIndex };
  }
  if (key === "Escape" && open) return { handled: true, open: false, activeIndex };
  return { handled: false, open, activeIndex };
}

export function shouldCloseThemedSelectOnPointerDown(isInsideRoot: boolean): boolean {
  return !isInsideRoot;
}
