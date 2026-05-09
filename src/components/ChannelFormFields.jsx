import ToggleSwitch from './ToggleSwitch'
import {
  PLAYER_TYPES,
  SECTION_OPTIONS,
  formInputClass,
  formLabelClass,
  formSelectClass,
} from './channelFormModel'

function ChannelFormFields({
  formId,
  form,
  updateField,
  thumbnailPreview,
  onThumbnailChange,
}) {
  const ic = formInputClass()
  const sc = formSelectClass()
  const lc = formLabelClass()

  return (
    <div className="space-y-5">
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
        />
      </div>

      <div>
        <label htmlFor={`${formId}-section`} className={lc}>
          Display Section
        </label>
        <select
          id={`${formId}-section`}
          value={form.displaySection}
          onChange={(e) => updateField('displaySection', e.target.value)}
          className={sc}
        >
          {SECTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

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
      </div>

      <div>
        <label htmlFor={`${formId}-bottom`} className={lc}>
          Display Section (Bottom Tabs)
        </label>
        <select
          id={`${formId}-bottom`}
          value={form.bottomTabsDisplay}
          onChange={(e) => updateField('bottomTabsDisplay', e.target.value)}
          className={sc}
        >
          {SECTION_OPTIONS.map((opt) => (
            <option key={`bottom-${opt.value}`} value={opt.label}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="rounded-xl border border-slate-600/50 bg-slate-900/30 p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Options
        </legend>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={form.live}
              onChange={(e) => updateField('live', e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            Live
          </label>
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
