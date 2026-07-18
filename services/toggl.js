async function getTogglEntries(apiToken, baseDate) {
  const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1);

  const response = await fetch(
    `https://api.track.toggl.com/api/v9/me/time_entries?start_date=${startOfDay.toISOString()}&end_date=${endOfDay.toISOString()}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiToken}:api_token`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) throw new Error(`Toggl API error: ${response.status}`);

  const entries = await response.json();
  return formatTogglEntries(entries);
}

function formatTogglEntries(entries) {
  const descriptions = entries.map((entry) => entry.description || '(タイトルなし)');
  return [...new Set(descriptions)].map((description) => `・${description}`);
}

module.exports = { formatTogglEntries, getTogglEntries };
