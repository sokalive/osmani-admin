import { useCallback, useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import ChannelFormFields from './ChannelFormFields'
import { channelToForm, emptyFormState } from './channelFormModel'

/**
 * Shared modal for Add + Edit channel — same layout and fields.
 * @param {'add'|'edit'} variant
 */
function ChannelFormModal({ variant, isOpen, channel, onClose, onSubmit }) {
  const formId = useId()
  const [form, setForm] = useState(() =>
    variant === 'edit' ? channelToForm(channel) : emptyFormState(),
  )
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [thumbnailPreview, setThumbnailPreview] = useState(null)
  const [instructionVideoFile, setInstructionVideoFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [instructionVideoUploadProgress, setInstructionVideoUploadProgress] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    if (variant === 'edit' && channel) {
      setForm(channelToForm(channel))
      setThumbnailFile(null)
      setThumbnailPreview(channel.thumbnailUrl ?? null)
      setInstructionVideoFile(null)
      setInstructionVideoUploadProgress(null)
      setSubmitting(false)
    }
    if (variant === 'add') {
      setForm(emptyFormState())
      setThumbnailFile(null)
      setThumbnailPreview(null)
      setInstructionVideoFile(null)
      setInstructionVideoUploadProgress(null)
      setSubmitting(false)
    }
  }, [isOpen, variant, channel])

  useEffect(() => {
    return () => {
      if (thumbnailPreview?.startsWith('blob:')) {
        URL.revokeObjectURL(thumbnailPreview)
      }
    }
  }, [thumbnailPreview])

  const handleBackdropMouseDown = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!isOpen) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleThumbnailChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (thumbnailPreview?.startsWith('blob:')) {
      URL.revokeObjectURL(thumbnailPreview)
    }
    setThumbnailFile(file)
    setThumbnailPreview(URL.createObjectURL(file))
  }

  function handleInstructionVideoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setInstructionVideoFile(file)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return
    const name = form.name.trim()
    const streamUrl = form.streamUrlPrimary.trim()
    const instruction = Boolean(form.isInstructionVideo)
    if (!name || (!instruction && !streamUrl)) return

    setSubmitting(true)
    setInstructionVideoUploadProgress(null)
    try {
      await onSubmit(
        {
          ...form,
          name,
          streamUrlPrimary: streamUrl,
          backupStream1: form.backupStream1.trim(),
          backupStream2: form.backupStream2.trim(),
          origin: form.origin.trim(),
          referer: form.referer.trim(),
          userAgent: form.userAgent.trim(),
          thumbnailFile,
          thumbnailPreviewUrl: thumbnailPreview,
          instructionVideoFile,
        },
        {
          onUploadProgress: (progress) => setInstructionVideoUploadProgress(progress),
        },
      )
    } finally {
      setSubmitting(false)
      setInstructionVideoUploadProgress(null)
    }
  }

  if (!isOpen) return null

  const isEdit = variant === 'edit'
  const subtitle = isEdit ? 'Edit channel' : 'New channel'
  const title = isEdit ? form.name || 'Untitled' : 'Add Channel'
  const submitLabel = isEdit ? 'Update Channel' : 'Add Channel'

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-title`}
    >
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-hidden
        onMouseDown={handleBackdropMouseDown}
      />

      <div className="relative flex max-h-[min(90vh,920px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-600/50 bg-[#0f172a] shadow-[0_24px_80px_rgba(0,0,0,0.55)] ring-1 ring-amber-500/15">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-700/70 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">
              {subtitle}
            </p>
            <h2 id={`${formId}-title`} className="mt-1 text-xl font-bold text-white">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-amber-300 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form
          id={`${formId}-form`}
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="custom-scrollbar flex-1 overflow-y-auto overscroll-contain px-5 py-5">
            <ChannelFormFields
              formId={formId}
              form={form}
              updateField={updateField}
              thumbnailPreview={thumbnailPreview}
              onThumbnailChange={handleThumbnailChange}
              instructionVideoFile={instructionVideoFile}
              onInstructionVideoChange={handleInstructionVideoChange}
              instructionVideoUploadProgress={instructionVideoUploadProgress}
            />
          </div>

          <footer className="shrink-0 border-t border-slate-700/70 bg-[#0f172a]/95 px-5 py-4">
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-[200px] sm:px-8"
            >
              {submitting
                ? instructionVideoUploadProgress
                  ? `Uploading ${instructionVideoUploadProgress.percent}%…`
                  : 'Saving…'
                : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

export default ChannelFormModal
