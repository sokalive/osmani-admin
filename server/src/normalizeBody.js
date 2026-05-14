/** Normalize request body (camelCase + streamUrlPrimary alias) */
export function bodyToInsert(body) {
  const url = (body.url ?? body.streamUrlPrimary ?? '').trim()
  const name = (body.name ?? '').trim()
  const category = (body.category ?? body.displaySection ?? 'Home').trim() || 'Home'
  return {
    name,
    category,
    url,
    backup_stream_1: (body.backupStream1 ?? '').trim(),
    backup_stream_2: (body.backupStream2 ?? '').trim(),
    origin: (body.origin ?? '').trim(),
    referer: (body.referer ?? '').trim(),
    user_agent: (body.userAgent ?? '').trim(),
    player_type: (body.playerType ?? 'Exo').trim() || 'Exo',
    access_premium: Boolean(body.accessPremium),
    live: body.live !== undefined ? Boolean(body.live) : true,
    hd: body.hd !== undefined ? Boolean(body.hd) : true,
    active: body.active !== undefined ? Boolean(body.active) : true,
    show_in_app: body.showInApp !== undefined ? Boolean(body.showInApp) : true,
    thumbnail_url: body.thumbnailUrl ?? null,
  }
}
