export function installRoomControlsV1(world, select, grid, onOpen) {
  const sorted = world.rooms.slice().sort((left, right) =>
    left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex);
  const buttons = new Map();
  sorted.forEach((room) => {
    const label = room.position.join("×");
    const option = document.createElement("option");
    option.value = room.fileName;
    option.textContent = label;
    select.append(option);

    const button = document.createElement("button");
    button.type = "button";
    button.title = `Play room ${label}`;
    button.setAttribute("aria-label", `Play room ${label}`);
    button.addEventListener("click", () => onOpen(room));
    grid.append(button);
    buttons.set(room.fileName, button);
  });
  select.addEventListener("change", () => {
    const room = world.rooms.find((candidate) => candidate.fileName === select.value);
    if (room) onOpen(room);
  });
  return (room) => {
    select.value = room.fileName;
    buttons.forEach((button, fileName) => {
      button.classList.toggle("is-current", fileName === room.fileName);
    });
  };
}

