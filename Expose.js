// ExposeBackend.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const basicAuth = require('express-basic-auth');

const app = express();
const PORT = 9000;

// 🔐 Auth basique
app.use(
  basicAuth({
    users: { admin: "monmotdepasse" },
    challenge: true,
    unauthorizedResponse: () => "Accès refusé",
  })
);

const ROOT_PATH = path.join(process.env.HOME, "SETRAFbackend");

// Fonction sécurisée pour rester dans ROOT_PATH
function safeJoin(base, target) {
  const targetPath = path.resolve(base, target);
  if (!targetPath.startsWith(base)) throw new Error("Accès non autorisé");
  return targetPath;
}

// API : lister fichiers/dossiers
app.get("/api/files", (req, res) => {
  const subPath = req.query.path || "";
  try {
    const currentPath = safeJoin(ROOT_PATH, subPath);
    const items = fs.readdirSync(currentPath).map((name) => {
      const fullPath = path.join(currentPath, name);
      const stats = fs.statSync(fullPath);
      return {
        name,
        isDir: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime,
      };
    });
    res.json({ path: subPath, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API : afficher le contenu d’un fichier
app.get("/api/view", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send("Chemin requis");

  try {
    const fullPath = safeJoin(ROOT_PATH, filePath);
    if (!fs.existsSync(fullPath)) return res.status(404).send("Fichier introuvable");
    if (fs.statSync(fullPath).isDirectory()) return res.status(400).send("Impossible d'afficher un dossier");

    const content = fs.readFileSync(fullPath, "utf8");
    res.send(`<pre style="white-space: pre-wrap; word-wrap: break-word;">${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`);
  } catch (err) {
    res.status(403).send(err.message);
  }
});

// Interface Web
app.get("/", (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <title>Gestionnaire Backend</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <style>
      body { font-family: Arial, sans-serif; background:#f4f4f4; margin:0; }
      header { background:#28a745; color:white; padding:1rem; text-align:center; }
      h1 { margin:0; font-size:1.5rem; }
      .container { padding:1rem; max-width:900px; margin:auto; }
      table { width:100%; border-collapse:collapse; background:white; box-shadow:0 0 10px rgba(0,0,0,0.1); }
      th, td { padding:0.8rem; text-align:left; border-bottom:1px solid #ddd; }
      th { background:#28a745; color:white; }
      tr:hover { background:#f1f1f1; }
      a { color:#28a745; text-decoration:none; }
      a:hover { text-decoration:underline; }
      i { margin-right:0.5rem; }
      .size { color:#555; font-size:0.9rem; }
      .date { color:#777; font-size:0.85rem; }
      .breadcrumb { margin-bottom:1rem; }
      pre { background:#eee; padding:1rem; overflow:auto; max-height:400px; }
    </style>
  </head>
  <body>
    <header>
      <h1><i class="fa-solid fa-database"></i> Gestionnaire Backend</h1>
    </header>
    <div class="container">
      <div class="breadcrumb" id="breadcrumb"></div>
      <table id="filesTable">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Taille</th>
            <th>Modifié</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div id="fileContent"></div>
    </div>
    <script>
      let currentPath = "";

      function updateBreadcrumb() {
        const bc = document.getElementById("breadcrumb");
        if (!currentPath) { bc.innerHTML = '<b>Racine</b>'; return; }
        const parts = currentPath.split("/");
        let pathAcc = "";
        bc.innerHTML = parts.map((p,i) => {
          pathAcc = parts.slice(0,i+1).join("/");
          return '<a href="#" onclick="loadFiles(\\''+pathAcc+'\\')">'+p+'</a>';
        }).join(" / ");
      }

      async function loadFiles(path = "") {
        const res = await fetch('/api/files?path=' + encodeURIComponent(path));
        const data = await res.json();
        if (data.error) { alert(data.error); return; }
        currentPath = data.path;
        updateBreadcrumb();
        document.getElementById('fileContent').innerHTML = '';
        const tbody = document.querySelector('tbody');
        tbody.innerHTML = '';

        if (data.path) {
          const tr = document.createElement('tr');
          const parent = data.path.split("/").slice(0,-1).join("/");
          tr.innerHTML = '<td colspan="4"><a href="#" onclick="loadFiles(\\''+parent+'\\')"><i class="fa-solid fa-arrow-left"></i> Retour</a></td>';
          tbody.appendChild(tr);
        }

        data.items.forEach(item => {
          const tr = document.createElement('tr');
          if (item.isDir) {
            tr.innerHTML = \`
              <td><i class="fa-solid fa-folder"></i> <a href="#" onclick="loadFiles('\${currentPath ? currentPath + '/' : ''}\${item.name}')">\${item.name}</a></td>
              <td class="size">--</td>
              <td class="date">\${new Date(item.mtime).toLocaleString()}</td>
              <td></td>
            \`;
          } else {
            tr.innerHTML = \`
              <td><i class="fa-solid fa-file"></i> \${item.name}</td>
              <td class="size">\${(item.size/1024).toFixed(2)} KB</td>
              <td class="date">\${new Date(item.mtime).toLocaleString()}</td>
              <td><a href="#" onclick="viewFile('\${currentPath ? currentPath + '/' : ''}\${item.name}')"><i class="fa-solid fa-eye"></i> Voir</a></td>
            \`;
          }
          tbody.appendChild(tr);
        });
      }

      async function viewFile(filePath) {
        const res = await fetch('/api/view?path=' + encodeURIComponent(filePath));
        const content = await res.text();
        document.getElementById('fileContent').innerHTML = content;
      }

      loadFiles();
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

app.listen(PORT, () => console.log(`📂 Backend accessible sur http://localhost:${PORT}`));
