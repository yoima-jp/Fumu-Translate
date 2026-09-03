const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');

app.whenReady().then(() => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
  database.prepare('INSERT INTO smoke (value) VALUES (?)').run('ok');
  const row = database.prepare('SELECT value FROM smoke').get();
  database.close();
  process.stdout.write(`electron node:sqlite ${row?.value ?? 'failed'}\n`);
  app.quit();
});
