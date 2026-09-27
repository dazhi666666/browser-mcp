const fs = require("fs");
const { port, token } = JSON.parse(fs.readFileSync("C:/Users/user/.browser-mcp/server.json", "utf8"));

async function cmd(command) {
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ command }),
  });
  return res.json();
}

const exprs = process.argv.slice(2);
(async () => {
  for (const expression of exprs) {
    const r = await cmd({ method: "evaluate", expression });
    console.log(JSON.stringify(expression.slice(0, 80)), "=>", JSON.stringify(r).slice(0, 300));
  }
})();
