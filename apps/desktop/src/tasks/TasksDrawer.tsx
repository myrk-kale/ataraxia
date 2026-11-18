import { SideDrawer } from "../ui/Overlay";
import { TasksSpace } from "./TasksSpace";

/**
 * The task list as a side panel over whatever is on screen, the way the artifacts open: it is
 * reached from its icon in the header or with Ctrl/Cmd T, and Esc or a click outside closes it.
 */
export function TasksDrawer({
  isOpen,
  onClose,
  onError,
  searchNumber,
}: {
  isOpen: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  searchNumber?: number | null;
}) {
  return (
    <SideDrawer isOpen={isOpen} label="Tasks" onClose={onClose}>
      <div className="h-full min-h-0">
        <TasksSpace active={isOpen} layout="drawer" searchNumber={searchNumber} onError={onError} />
      </div>
    </SideDrawer>
  );
}
