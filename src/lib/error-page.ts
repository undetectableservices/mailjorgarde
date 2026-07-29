export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Impossible d’afficher cette page</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: radial-gradient(circle at top, #1d2440, #080a11 58%); color: #f7f8fb; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; border: 1px solid rgba(255,255,255,.12); border-radius: 1.5rem; background: rgba(18,21,33,.82); box-shadow: 0 30px 90px rgba(0,0,0,.45); }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #aab0c0; margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.65rem 1.1rem; border-radius: 0.75rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: linear-gradient(135deg, #8b5cf6, #55dcff); color: #fff; }
      .secondary { background: rgba(255,255,255,.04); color: #f7f8fb; border-color: rgba(255,255,255,.12); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Impossible d’afficher cette page</h1>
      <p>Une erreur est survenue. Actualisez la page ou revenez à l’accueil.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Réessayer</button>
        <a class="secondary" href="/">Retour à l’accueil</a>
      </div>
    </div>
  </body>
</html>`;
}
