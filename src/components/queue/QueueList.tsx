import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  FixedSizeList as List,
  areEqual,
  type FixedSizeListHandle,
  type ListChildComponentProps,
} from "react-window";
import type { QueueItem as QueueItemModel } from "../../types/queue";
import { QueueItem } from "./QueueItem";

const ITEM_HEIGHT = 64;
const OVERSCAN_COUNT = 10;
const DEFAULT_HEIGHT = 384;

interface QueueListProps {
  items: QueueItemModel[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: string[]) => void;
  onItemClick: (id: string) => void;
  onQuickLook: (id: string) => void;
}

interface QueueRowData {
  items: QueueItemModel[];
  selectedIds: Set<string>;
  onRowClick: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onRowQuickLook: (index: number) => void;
}

function clampIndex(index: number, size: number): number {
  if (size === 0) {
    return -1;
  }

  return Math.max(0, Math.min(index, size - 1));
}

function collectRangeIds(items: QueueItemModel[], fromIndex: number, toIndex: number): string[] {
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  const ids: string[] = [];

  for (let index = start; index <= end; index += 1) {
    ids.push(items[index].id);
  }

  return ids;
}

const Row = memo(
  ({ index, style, data }: ListChildComponentProps<QueueRowData>) => {
    const item = data.items[index];
    const isSelected = data.selectedIds.has(item.id);

    return (
      <QueueItem
        item={item}
        isSelected={isSelected}
        style={style}
        onClick={(event) => data.onRowClick(index, event)}
        onQuickLook={() => data.onRowQuickLook(index)}
      />
    );
  },
  (prevProps, nextProps) => {
    if (!areEqual(prevProps, nextProps)) {
      return false;
    }

    const prevItem = prevProps.data.items[prevProps.index];
    const nextItem = nextProps.data.items[nextProps.index];

    return (
      prevItem === nextItem &&
      prevProps.data.selectedIds.has(prevItem.id) ===
        nextProps.data.selectedIds.has(nextItem.id)
    );
  }
);

function QueueListComponent({
  items,
  selectedIds,
  onSelectionChange,
  onItemClick,
  onQuickLook,
}: QueueListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeListHandle>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [focusedIndex, setFocusedIndex] = useState(() =>
    selectedIds.size > 0 ? Math.max(0, items.findIndex((item) => selectedIds.has(item.id))) : 0
  );
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const safeFocusedIndex = useMemo(() => {
    if (items.length === 0) {
      return -1;
    }

    if (focusedIndex >= 0 && focusedIndex < items.length) {
      return focusedIndex;
    }

    const firstSelected = items.findIndex((item) => selectedIds.has(item.id));
    return firstSelected >= 0 ? firstSelected : 0;
  }, [focusedIndex, items, selectedIds]);

  const safeAnchorIndex = useMemo(() => {
    if (anchorIndex === null || items.length === 0) {
      return null;
    }

    return clampIndex(anchorIndex, items.length);
  }, [anchorIndex, items.length]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const syncHeight = () => {
      if (node.clientHeight > 0) {
        setHeight(node.clientHeight);
      }
    };

    syncHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const applySingleSelection = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) {
        return;
      }

      const id = items[index].id;
      onSelectionChange([id]);
      onItemClick(id);
      setFocusedIndex(index);
      setAnchorIndex(index);
      listRef.current?.scrollToItem(index, "smart");
    },
    [items, onItemClick, onSelectionChange]
  );

  const applyToggleSelection = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) {
        return;
      }

      const id = items[index].id;
      const nextSelected = new Set(selectedIds);

      if (nextSelected.has(id)) {
        nextSelected.delete(id);
      } else {
        nextSelected.add(id);
      }

      onSelectionChange(Array.from(nextSelected));
      onItemClick(id);
      setFocusedIndex(index);
      setAnchorIndex(index);
      listRef.current?.scrollToItem(index, "smart");
    },
    [items, onItemClick, onSelectionChange, selectedIds]
  );

  const applyRangeSelection = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) {
        return;
      }

      const targetAnchor =
        safeAnchorIndex ??
        (() => {
          const firstSelected = items.findIndex((item) => selectedIds.has(item.id));
          return firstSelected >= 0 ? firstSelected : index;
        })();

      const nextIds = collectRangeIds(items, targetAnchor, index);
      onSelectionChange(nextIds);
      onItemClick(items[index].id);
      setFocusedIndex(index);
      setAnchorIndex(targetAnchor);
      listRef.current?.scrollToItem(index, "smart");
    },
    [items, onItemClick, onSelectionChange, safeAnchorIndex, selectedIds]
  );

  const handleQuickLook = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) {
        return;
      }

      onQuickLook(items[index].id);
    },
    [items, onQuickLook]
  );

  const handleRowClick = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (event.shiftKey) {
        applyRangeSelection(index);
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        applyToggleSelection(index);
        return;
      }

      applySingleSelection(index);
      handleQuickLook(index);
    },
    [applyRangeSelection, applySingleSelection, applyToggleSelection, handleQuickLook]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (items.length === 0) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onSelectionChange(items.map((item) => item.id));
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      event.preventDefault();

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const fallbackIndex =
        safeFocusedIndex >= 0
          ? safeFocusedIndex
          : Math.max(0, items.findIndex((item) => selectedIds.has(item.id)));
      const nextIndex = clampIndex(fallbackIndex + direction, items.length);
      if (nextIndex < 0) {
        return;
      }

      if (event.shiftKey) {
        const nextAnchor = safeAnchorIndex ?? fallbackIndex;
        const rangeIds = collectRangeIds(items, nextAnchor, nextIndex);
        onSelectionChange(rangeIds);
        setAnchorIndex(nextAnchor);
      } else {
        onSelectionChange([items[nextIndex].id]);
        setAnchorIndex(nextIndex);
      }

      onItemClick(items[nextIndex].id);
      setFocusedIndex(nextIndex);
      listRef.current?.scrollToItem(nextIndex, "smart");
    },
    [
      items,
      onItemClick,
      onSelectionChange,
      safeAnchorIndex,
      safeFocusedIndex,
      selectedIds,
    ]
  );

  const itemData = useMemo<QueueRowData>(
    () => ({
      items,
      selectedIds,
      onRowClick: handleRowClick,
      onRowQuickLook: handleQuickLook,
    }),
    [handleQuickLook, handleRowClick, items, selectedIds]
  );

  return (
    <div
      ref={containerRef}
      className="queue-list"
      data-testid="queue-list"
      role="listbox"
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <List
        ref={listRef}
        height={height}
        width="100%"
        itemCount={items.length}
        itemSize={ITEM_HEIGHT}
        itemData={itemData}
        overscanCount={OVERSCAN_COUNT}
      >
        {Row}
      </List>
      <div className="queue-list__sr-status" aria-live="polite">
        {selectedIds.size === 0
          ? "No items selected."
          : `${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"} selected.`}
      </div>
    </div>
  );
}

export const QueueList = memo(QueueListComponent);
