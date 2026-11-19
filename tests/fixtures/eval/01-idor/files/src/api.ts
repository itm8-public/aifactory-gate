import express from 'express';
const app = express();
app.get('/api/users/:id', async (req, res) => {
  const user = await db.users.find(req.params.id);
  res.json(user);
});
