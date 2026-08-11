export default function EmployeeMultiSelect({ employees, selectedIds, onChange }) {
  const allSelected = employees.length > 0 && selectedIds.length === employees.length;

  const toggle = (id) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };
  const toggleAll = () => onChange(allSelected ? [] : employees.map((e) => e.id));

  return (
    <div className="multi-select">
      <label className="multi-select-all">
        <input type="checkbox" checked={allSelected} onChange={toggleAll} />
        <span>All employees</span>
      </label>
      <div className="multi-select-list">
        {employees.map((emp) => (
          <label key={emp.id} className="multi-select-item">
            <input type="checkbox" checked={selectedIds.includes(emp.id)} onChange={() => toggle(emp.id)} />
            <span>{emp.first_name} {emp.last_name}</span>
          </label>
        ))}
        {employees.length === 0 && <div className="subtitle" style={{ margin: 0, padding: "6px 4px" }}>No employees found.</div>}
      </div>
    </div>
  );
}
