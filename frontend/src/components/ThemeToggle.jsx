import { useTheme } from "../context/ThemeContext";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggleTheme}
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-icon theme-toggle-icon-sun">☀️</span>
        <span className="theme-toggle-icon theme-toggle-icon-moon">🌙</span>
        <span className="theme-toggle-knob" />
      </span>
    </button>
  );
}
