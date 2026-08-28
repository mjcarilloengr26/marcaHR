import { useEffect, useId, useState } from "react";
import { api } from "../api/client";

// Values already in use, cached per field. The same field appears on several
// forms and a modal can be opened repeatedly, so without this a customer list
// would be re-fetched on every open.
//
// The entry expires rather than living for the whole session: a name typed on
// an opportunity should be offered when the matching invoice is raised a
// minute later, without anyone having to reload the page to see it.
const TTL_MS = 60_000;
const cache = new Map(); // field -> { at, promise }

function loadField(field) {
  const hit = cache.get(field);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

  const promise = api
    .get(`/suggestions?field=${encodeURIComponent(field)}`)
    .then((d) => d.values || [])
    // Suggestions are a convenience. A failed lookup must never stop somebody
    // typing the value themselves, so fall back to an empty list.
    .catch(() => []);

  cache.set(field, { at: Date.now(), promise });
  return promise;
}

// A plain text input backed by the browser's own datalist: typing filters the
// values already used elsewhere in the app, and anything not on the list can
// still be typed. Deliberately not a select — these are open sets, and forcing
// a choice would block the first-ever customer from ever being entered.
export default function SuggestInput({ field, value, onChange, ...rest }) {
  const listId = useId();
  const [options, setOptions] = useState([]);

  useEffect(() => {
    let alive = true;
    loadField(field).then((v) => {
      if (alive) setOptions(v);
    });
    return () => {
      alive = false;
    };
  }, [field]);

  return (
    <>
      <input list={listId} value={value} onChange={onChange} {...rest} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
