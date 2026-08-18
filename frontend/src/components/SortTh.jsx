// A <th> whose whole label is a click target for toggling sort on sortKey,
// paired with the useSort hook's toggleSort/arrow. Kept as its own component
// since the same three-prop pattern repeats across every sortable table page.
export default function SortTh({ label, sortKey, toggleSort, arrow, className }) {
  return (
    <th className={className}>
      <button type="button" className="link-btn" onClick={() => toggleSort(sortKey)}>
        {label}{arrow(sortKey)}
      </button>
    </th>
  );
}
