// Stable authored room references let the browser cache background geometry.
// Only the active room receives live engine state; physics remains room-local.
export function createPlayWorldContext(world) {
  const contextRooms = world.rooms.map(room => ({
    ...room,
    renderDimmed: true,
    objects: room.objects.filter(object =>
      world.blockDefinitions.get(object.blockId)?.roleId !== "player")
  }));

  return (room, renderedRoom = room) => ({
    ...world,
    contextRooms,
    rooms: contextRooms.map(background => background.fileName === room.fileName
      ? {
          ...room,
          ...renderedRoom,
          columnIndex: room.columnIndex,
          rowIndex: room.rowIndex,
          renderDimmed: false
        }
      : background),
    contextActiveRoom: {
      fileName: room.fileName,
      columnIndex: room.columnIndex,
      rowIndex: room.rowIndex
    }
  });
}

export function playRoomCenter(world) {
  const room = world.contextActiveRoom;
  return {
    x: (room.columnIndex + 0.5 - world.columns.length / 2) * world.roomWidth,
    z: (room.rowIndex + 0.5 - world.rows.length / 2) * world.roomHeight
  };
}
