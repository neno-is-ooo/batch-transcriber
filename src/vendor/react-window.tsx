/* eslint-disable react-refresh/only-export-components */
import {
  createElement,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ForwardedRef,
  type Ref,
  type ReactElement,
} from "react";

export interface ListChildComponentProps<TData> {
  data: TData;
  index: number;
  style: CSSProperties;
  isScrolling?: boolean;
}

export interface FixedSizeListHandle {
  scrollToItem: (index: number, align?: Align) => void;
}

type Align = "auto" | "smart" | "center" | "end" | "start";

interface FixedSizeListProps<TData> {
  className?: string;
  height: number;
  itemCount: number;
  itemData: TData;
  itemSize: number;
  overscanCount?: number;
  width: number | string;
  children: ComponentType<ListChildComponentProps<TData>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveScrollTopForIndex(
  index: number,
  align: Align,
  viewportHeight: number,
  rowHeight: number,
  currentScrollTop: number
): number {
  const itemTop = index * rowHeight;
  const itemBottom = itemTop + rowHeight;
  const viewportTop = currentScrollTop;
  const viewportBottom = currentScrollTop + viewportHeight;

  if (align === "center") {
    return itemTop - (viewportHeight - rowHeight) / 2;
  }

  if (align === "end") {
    return itemBottom - viewportHeight;
  }

  if (align === "start") {
    return itemTop;
  }

  const isVisible = itemTop >= viewportTop && itemBottom <= viewportBottom;
  if (align === "auto" && isVisible) {
    return currentScrollTop;
  }

  if (itemTop < viewportTop) {
    return itemTop;
  }

  if (itemBottom > viewportBottom) {
    return itemBottom - viewportHeight;
  }

  return currentScrollTop;
}

function FixedSizeListInner<TData>(
  {
    className,
    height,
    itemCount,
    itemData,
    itemSize,
    overscanCount = 1,
    width,
    children,
  }: FixedSizeListProps<TData>,
  ref: ForwardedRef<FixedSizeListHandle>
) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const safeItemCount = Math.max(0, itemCount);
  const totalHeight = safeItemCount * itemSize;
  const overscan = Math.max(0, overscanCount);

  const viewportEnd = scrollTop + height;
  const firstVisibleIndex = Math.floor(scrollTop / itemSize);
  const lastVisibleIndex = Math.ceil(viewportEnd / itemSize);
  const startIndex = clamp(firstVisibleIndex - overscan, 0, Math.max(0, safeItemCount - 1));
  const endIndex = clamp(lastVisibleIndex + overscan, 0, Math.max(0, safeItemCount - 1));

  const setScrollPosition = useCallback((nextScrollTop: number) => {
    const node = outerRef.current;
    if (!node) {
      return;
    }

    const maxScroll = Math.max(0, totalHeight - height);
    const clamped = clamp(nextScrollTop, 0, maxScroll);
    node.scrollTop = clamped;
    setScrollTop(clamped);
  }, [height, totalHeight]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToItem(index, align = "auto") {
        if (safeItemCount === 0) {
          return;
        }

        const clampedIndex = clamp(index, 0, safeItemCount - 1);
        const nextScrollTop = resolveScrollTopForIndex(
          clampedIndex,
          align,
          height,
          itemSize,
          outerRef.current?.scrollTop ?? scrollTop
        );

        setScrollPosition(nextScrollTop);
      },
    }),
    [height, itemSize, safeItemCount, scrollTop, setScrollPosition]
  );

  const rows = useMemo(() => {
    if (safeItemCount === 0) {
      return [];
    }

    const nextRows: ReactElement[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      nextRows.push(
        createElement(children, {
          key: index,
          data: itemData,
          index,
          style: {
            position: "absolute",
            top: index * itemSize,
            left: 0,
            width: "100%",
            height: itemSize,
          },
        })
      );
    }
    return nextRows;
  }, [children, endIndex, itemData, itemSize, safeItemCount, startIndex]);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        height,
        width,
        overflowY: "auto",
        overflowX: "hidden",
        position: "relative",
      }}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <div
        style={{
          height: totalHeight,
          width: "100%",
          position: "relative",
        }}
      >
        {rows}
      </div>
    </div>
  );
}

type FixedSizeListComponent = <TData>(
  props: FixedSizeListProps<TData> & { ref?: Ref<FixedSizeListHandle> }
) => ReactElement;

export const FixedSizeList = forwardRef(FixedSizeListInner) as FixedSizeListComponent;

export const areEqual = <TData,>(
  prevProps: ListChildComponentProps<TData>,
  nextProps: ListChildComponentProps<TData>
): boolean => {
  return (
    prevProps.index === nextProps.index &&
    prevProps.data === nextProps.data &&
    prevProps.style === nextProps.style
  );
};
