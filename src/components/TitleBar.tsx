interface TitleBarProps {
  title?: string;
}

export function TitleBar({ title = "Batch Transcriber" }: TitleBarProps) {
  return (
    <header className="titlebar" data-tauri-drag-region data-testid="titlebar">
      <div className="traffic-lights" aria-hidden="true">
        <span className="traffic-light traffic-light--close" />
        <span className="traffic-light traffic-light--minimize" />
        <span className="traffic-light traffic-light--maximize" />
      </div>
      <span className="window-title">{title}</span>
    </header>
  );
}
