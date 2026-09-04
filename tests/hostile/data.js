// The data a real user can produce and a fixture never does.
//
// Every value here is reachable: the note cap is the database's own 500-char
// check constraint, the name length is whatever someone types into a field
// with no maxlength, and the emoji come from any phone keyboard.
const UUID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// 200 characters of unbroken word — the shape that defeats word-wrap and
// pushes a flex sibling off the end of its row.
const LONG_NAME = ["Bartholomew-Wilhelmina", "Featherstonehaugh", "Cholmondeley",
  "Marie-Antoinette", "van der Bergh-Oyelaran", "Constantinopolitan", "Aloysius",
  "Threepwood", "Ferdinand", "de la Fontaine-Rutherford"].join(" ") + " III";
const UNBROKEN = "A".repeat(180);
const EMOJI_NAME = "👩🏾‍💻 Ana 🇦🇪 Ríos-Ñuñez 🧑‍🚀🧑‍🚀🧑‍🚀";
const CJK_NAME = "山田太郎の非常に長い名前をここに書きます真実です";
const RTL_NAME = "عبد الرحمن بن عبد الله بن محمد";
const NOTE_MAX = "Handover ".repeat(55) + "end.";           // ~500, the constraint ceiling
const NOTE_UNBROKEN = "z".repeat(500);

function pad2(n){ return String(n).padStart(2, "0"); }
function dateStr(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

// `days` consecutive days ending today. Types cycle so every branch of the
// renderers gets exercised, and a few days carry the extremes.
function entriesFor(userId, days, opts){
  opts = opts || {};
  const out = [];
  const today = new Date();
  const TYPES = ["regular","regular","regular","wfh","leave","sick","halfleave","holiday","trip","training","other"];
  for(let i = days - 1; i >= 0; i--){
    const d = new Date(today); d.setDate(d.getDate() - i);
    const type = TYPES[i % TYPES.length];
    const worked = type === "regular" || type === "halfleave" || type === "wfh";
    out.push({
      id: 1000 + out.length,
      user_id: userId,
      date: dateStr(d),
      clock_in:  worked ? `0${7 + (i % 2)}:${pad2((i * 7) % 60)}:00` : null,
      clock_out: worked ? `1${6 + (i % 3)}:${pad2((i * 11) % 60)}:00` : null,
      type,
      note: i % 17 === 0 ? NOTE_MAX : (i % 23 === 0 ? NOTE_UNBROKEN : ""),
      updated_at: "2026-01-01T00:00:00Z"
    });
  }
  if(opts.extremes){
    const d = new Date(today); d.setDate(d.getDate() - days);
    // A shift that runs to one minute before midnight, and an overnight one:
    // the two ends of the hours arithmetic, in the same month as everything else.
    out.unshift(
      { id: 900, user_id: userId, date: dateStr(d), clock_in: "00:00:00", clock_out: "23:59:00",
        type: "regular", note: NOTE_MAX, updated_at: "2026-01-01T00:00:00Z" },
      { id: 901, user_id: userId, date: dateStr(new Date(d.getTime() - 86400000)),
        clock_in: "22:30:00", clock_out: "06:15:00", type: "regular", note: "", updated_at: "2026-01-01T00:00:00Z" }
    );
  }
  return out;
}

function profile(n, over){
  return Object.assign({
    id: UUID(n),
    email: `person${n}@example.com`,
    full_name: `Person ${n}`,
    role: "user",
    avatar_updated_at: null,
    created_at: "2026-01-01T00:00:00Z"
  }, over || {});
}

// One admin (you), plus a roster whose first few names are each a different
// way of being hostile.
function roster(size){
  const people = [
    profile(1, { role: "admin", full_name: LONG_NAME }),
    profile(2, { full_name: UNBROKEN }),
    profile(3, { full_name: EMOJI_NAME }),
    profile(4, { full_name: CJK_NAME }),
    profile(5, { full_name: RTL_NAME }),
    profile(6, { full_name: null }),                                  // never set a name
    profile(7, { full_name: "", email: "a-very-long-email-address-that-nobody-would-type@some-department.example.com" })
  ];
  for(let n = people.length + 1; n <= size; n++) people.push(profile(n));
  return people;
}

const SETTINGS = {
  workDays: [0,1,2,3,4], targetMin: 480, graceMin: 10, lateOnlyIfShort: true,
  periods: [], standardIn: "08:00", standardOut: "16:00",
  remindAfterHours: 9, annualLeaveDays: 21
};

module.exports = {
  UUID, LONG_NAME, UNBROKEN, EMOJI_NAME, CJK_NAME, RTL_NAME, NOTE_MAX, NOTE_UNBROKEN,
  entriesFor, profile, roster, SETTINGS, dateStr
};
