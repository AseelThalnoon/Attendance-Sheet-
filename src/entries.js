// The translation between a database row and the object the app works with.
//
// Two shapes, on purpose: Postgres columns are snake_case and nullable, the
// app's objects are camelCase and never null. Keeping the conversion in one
// pair of functions is what stops `clock_in` and `clockIn` both turning up
// halfway through a render, and what makes "no time recorded" exactly one
// thing in the app (an empty string) rather than two (null or "").
//
// entryToRow takes the user id separately rather than reading it off the
// entry: the row being written is not always the signed-in person's -- an
// admin editing someone else's day writes through the same path -- and a
// mapper that assumed otherwise would silently file the edit under the wrong
// account.

function rowToEntry(row){
  return {
    id: row.id,
    user_id: row.user_id,
    date: row.date,
    clockIn: row.clock_in || "",
    clockOut: row.clock_out || "",
    type: row.type || "regular",
    note: row.note || ""
  };
}
function entryToRow(entry, userId){
  return {
    user_id: userId,
    date: entry.date,
    clock_in: entry.clockIn || null,
    clock_out: entry.clockOut || null,
    type: entry.type || "regular",
    note: entry.note || ""
  };
}

export { rowToEntry, entryToRow };
