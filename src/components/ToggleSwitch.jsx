function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F1A] disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'border-amber-400/60 bg-gradient-to-r from-amber-400 to-yellow-500'
          : 'border-slate-600 bg-slate-800'
      }`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow-md transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export default ToggleSwitch
