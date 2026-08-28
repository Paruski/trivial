const nativeFetch = window.fetch.bind(window);
const routerUrl = new URL('router.php', document.baseURI);

window.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    const url = new URL(routerUrl);
    url.searchParams.set('path', input);
    return nativeFetch(url, init);
  }
  return nativeFetch(input, init);
};

const status = document.querySelector('#status');
const newMatch = document.querySelector('#new-match');

function syncControls() {
  if (newMatch && status) newMatch.disabled = !status.classList.contains('online');
}

if (newMatch) newMatch.disabled = true;
if (status) new MutationObserver(syncControls).observe(status, {attributes:true, attributeFilter:['class']});

await import('./app.js');
syncControls();
