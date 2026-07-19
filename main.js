const parts = ['game-01.part', 'game-02.part', 'game-03.part', 'game-04.part', 'game-05.part', 'game-06.part', 'game-07.part', 'game-08.part'];
const status = document.querySelector('#load-label');
try {
  const responses = await Promise.all(parts.map((path) => fetch(`./${path}`)));
  const failed = responses.find((response) => !response.ok);
  if (failed) throw new Error(`Game code request failed: ${failed.status}`);
  const source = (await Promise.all(responses.map((response) => response.text()))).join('');
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { await import(url); } finally { URL.revokeObjectURL(url); }
} catch (error) {
  console.error(error);
  if (status) status.textContent = 'Game failed to load';
}
