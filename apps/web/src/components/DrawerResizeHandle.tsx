/**
 * Drag handle pinned to the left edge of a drawer.
 *
 * Rendered as a thin strip that widens its hit area beyond its visible width
 * so it is easy to grab without the grip looking heavy. The grip marks only
 * appear on hover or while dragging, keeping the drawer edge calm at rest.
 */
export function DrawerResizeHandle({
  dragging,
  handleProps,
}: {
  dragging: boolean;
  handleProps: Record<string, unknown>;
}) {
  return (
    <div
      className={`drawer-resize${dragging ? ' is-dragging' : ''}`}
      {...handleProps}
    >
      <span className="drawer-resize-grip" aria-hidden="true" />
    </div>
  );
}
