import ToggleSwitch from './ToggleSwitch'
import {
  INSTRUCTION_VISIBILITY_OPTIONS,
  PLAYER_TYPES,
  SECTION_OPTIONS,
  formInputClass,
  formLabelClass,
  formSelectClass,
} from './channelFormModel'

function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${Math.round(v)} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(1)} MB`
}

function formatEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—'
  if (sec < 60) return `${Math.ceil(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.ceil(sec % 60)
  return `${m}m ${s}s`
}

function ChannelFormFields({
  formId,
  form,
  updateField,
  thumbnailPreview,
  onThumbnailChange,
  instructionVideoFile,
  onInstructionVideoChange,
  instructionVideoUploadProgress,
}) {
  const ic = formInputClass()
  const sc = formSelectClass()
  const lc = formLabelClass()
  const instruction = Boolean(form.isInstructionVideo)

  function setDisplaySection(next) {
    updateField('displaySection', next)
    if (next === 'Home') updateField('tabHome', true)
    if (next === 'Sports') updateField('tabSports', true)
    if (next === 'Tamthilia') updateField('tabTamthilia', true)
  }

  return (
    <div className="space-y-5">
      {instruction ? (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
          System instruction video channel — always free, not deletable. Upload a portrait instruction
          video (e.g. how to update the app).
        </div>
      ) : null}

      <div>
        <label htmlFor={`${formId}-name`} className={lc}>
          Channel Name
        </label>
        <input
          id={`${formId}-name`}
          type="text"
          value={form.name}
          onChange={(e) => updateField('name', e.target.value)}
          className={ic}
          placeholder="Channel display name"
          required
          readOnly={instruction}
          disabled={instruction}
        />
      </div>

      <div>
        <label htmlFor={`${formId}-section`} className={lc}>
          Content line (Sports / Tamthilia tab filter)
        </label>
        <select
          id={`${formId}-section`}
          value={form.displaySection}
          onChange={(e) => setDisplaySection(e.target.value)}
          className={sc}
        >
          {SECTION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          Sports tab lists channels with this line set to <strong className="text-slate-400">Sports</strong> and
          Sports checked below. Tamthilia tab uses <strong className="text-slate-400">Tamthilia</strong>. Home mixes
          anything marked for the Home tab.
        </p>
      </div>

      <fieldset className="rounded-xl border border-slate-600/50 bg-slate-900/30 p-4">
        <legend className={lc}>Show on bottom tabs</legend>
        <p className="mb-3 text-xs text-slate-500">
          A channel can appear on multiple tabs (e.g. Home + Sports). The content line above is always included.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.tabHome}
              onChange={(e) => updateField('tabHome', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Home
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.tabSports}
              onChange={(e) => updateField('tabSports', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Sports
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.tabTamthilia}
              onChange={(e) => updateField('tabTamthilia', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Tamthilia
          </label>
        </div>
      </fieldset>

      {instruction ? (
        <>
          <div>
            <label htmlFor={`${formId}-instruction-visibility`} className={lc}>
              App visibility targeting
            </label>
            <select
              id={`${formId}-instruction-visibility`}
              value={form.instructionVisibility}
              onChange={(e) => updateField('instructionVisibility', e.target.value)}
              className={sc}
            >
              {INSTRUCTION_VISIBILITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className={lc}>Instruction video</span>
            <input
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              onChange={onInstructionVideoChange}
              className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cyan-200 hover:file:bg-cyan-500/30"
            />
            {instructionVideoFile ? (
              <p className="mt-2 text-xs text-cyan-300">Selected: {instructionVideoFile.name}</p>
            ) : form.videoUrl ? (
              <p className="mt-2 truncate text-xs text-slate-500">Current: {form.videoUrl}</p>
            ) : (
              <p className="mt-2 text-xs text-slate-500">No video uploaded yet.</p>
            )}
            {instructionVideoUploadProgress ? (
              <div className="mt-3 space-y-1.5 rounded-lg border border-cyan-500/30 bg-slate-900/60 p-3">
                <div className="flex items-center justify-between text-xs text-cyan-100">
                  <span>Uploading… {instructionVideoUploadProgress.percent}%</span>
                  <span>
                    {formatBytes(instructionVideoUploadProgress.speedBps)}/s · ETA{' '}
                    {formatEta(instructionVideoUploadProgress.etaSec)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-cyan-300 transition-[width] duration-150"
                    style={{ width: `${instructionVideoUploadProgress.percent}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-500">
                  {formatBytes(instructionVideoUploadProgress.loaded)} /{' '}
                  {formatBytes(instructionVideoUploadProgress.total)}
                </p>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
      <div>
        <label htmlFor={`${formId}-primary`} className={lc}>
          Stream URL (Primary)
        </label>
        <input
          id={`${formId}-primary`}
          type="url"
          value={form.streamUrlPrimary}
          onChange={(e) => updateField('streamUrlPrimary', e.target.value)}
          placeholder="https://"
          className={ic}
          required
        />
      </div>

      <div>
        <label htmlFor={`${formId}-b1`} className={lc}>
          Backup Stream 1
        </label>
        <input
          id={`${formId}-b1`}
          type="url"
          value={form.backupStream1}
          onChange={(e) => updateField('backupStream1', e.target.value)}
          placeholder="https://"
          className={ic}
        />
      </div>

      <div>
        <label htmlFor={`${formId}-b2`} className={lc}>
          Backup Stream 2
        </label>
        <input
          id={`${formId}-b2`}
          type="url"
          value={form.backupStream2}
          onChange={(e) => updateField('backupStream2', e.target.value)}
          placeholder="https://"
          className={ic}
        />
      </div>

      <div>
        <label htmlFor={`${formId}-origin`} className={lc}>
          Origin{' '}
          <span className="font-normal normal-case text-slate-500">(optional)</span>
        </label>
        <input
          id={`${formId}-origin`}
          type="text"
          value={form.origin}
          onChange={(e) => updateField('origin', e.target.value)}
          className={ic}
          placeholder="https://origin.example"
        />
      </div>

      <div>
        <label htmlFor={`${formId}-referer`} className={lc}>
          Referer{' '}
          <span className="font-normal normal-case text-slate-500">(optional)</span>
        </label>
        <input
          id={`${formId}-referer`}
          type="text"
          value={form.referer}
          onChange={(e) => updateField('referer', e.target.value)}
          className={ic}
        />
      </div>

      <div>
        <label htmlFor={`${formId}-ua`} className={lc}>
          User-Agent{' '}
          <span className="font-normal normal-case text-slate-500">(optional)</span>
        </label>
        <input
          id={`${formId}-ua`}
          type="text"
          value={form.userAgent}
          onChange={(e) => updateField('userAgent', e.target.value)}
          className={ic}
          placeholder="Mozilla/5.0 …"
        />
      </div>

      <div>
        <label htmlFor={`${formId}-player`} className={lc}>
          Player Type
        </label>
        <select
          id={`${formId}-player`}
          value={form.playerType}
          onChange={(e) => updateField('playerType', e.target.value)}
          className={sc}
        >
          {PLAYER_TYPES.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
        </>
      )}

      <div>
        <span className={lc}>Thumbnail</span>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept="image/*"
            onChange={onThumbnailChange}
            className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-500/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-amber-200 hover:file:bg-amber-500/30"
          />
          {thumbnailPreview ? (
            <div className="shrink-0 overflow-hidden rounded-xl border border-slate-600/60 bg-slate-900">
              <img src={thumbnailPreview} alt="" className="h-20 w-36 object-cover" />
            </div>
          ) : (
            <div className="flex h-20 w-36 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-600/70 bg-slate-900/50 text-xs text-slate-500">
              No preview
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-600/50 bg-slate-900/40 px-3 py-3">
        <span className="text-sm font-medium text-slate-300">Access Type</span>
        {instruction ? (
          <span className="text-xs font-bold uppercase tracking-wide text-emerald-300">Free (locked)</span>
        ) : (
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-bold uppercase tracking-wide ${form.accessPremium ? 'text-slate-500' : 'text-amber-300'}`}
          >
            Free
          </span>
          <ToggleSwitch
            checked={form.accessPremium}
            onChange={(next) => updateField('accessPremium', next)}
            aria-label="Toggle Premium access"
          />
          <span
            className={`text-xs font-bold uppercase tracking-wide ${form.accessPremium ? 'text-amber-300' : 'text-slate-500'}`}
          >
            Premium
          </span>
        </div>
        )}
      </div>

      <fieldset className="rounded-xl border border-slate-600/50 bg-slate-900/30 p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Options
        </legend>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!instruction ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.live}
              onChange={(e) => updateField('live', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Live
          </label>
          ) : null}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.hd}
              onChange={(e) => updateField('hd', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            HD
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => updateField('active', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Active
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.showInApp}
              onChange={(e) => updateField('showInApp', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Show in App
          </label>
        </div>
      </fieldset>
    </div>
  )
}

export default ChannelFormFields
