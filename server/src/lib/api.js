const BASE_URL = import.meta.env.VITE_API_BASE_URL

export async function getChannels() {
  const res = await fetch(`${BASE_URL}/api/channels`)
  if (!res.ok) throw new Error('Failed to fetch channels')
  return res.json()
}

export async function createChannel(data) {
  const res = await fetch(`${BASE_URL}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create channel')
  return res.json()
}

export async function deleteChannel(id) {
  const res = await fetch(`${BASE_URL}/api/channels/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete channel')
}