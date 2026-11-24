export async function convertCad(path, body, signal) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    signal,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error || 'The local converter is unavailable. Restart the CAD launcher and retry.');
  }
  return response;
}

export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*]/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
