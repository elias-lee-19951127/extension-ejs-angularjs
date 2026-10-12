// Express serves the EJS page and the AngularJS assets. Start with `npm run debug`, then
// "EJS/NG: Connect to Runtime" in VS Code: the console.log below shows inline, next to its line.
var express = require('express');
var path = require('path');

var app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

var tasks = [
  { id: 1, title: 'Write the release notes', done: false, priority: 2, owner: { name: 'Lan' } },
  { id: 2, title: 'Fix the login redirect', done: true, priority: 3, owner: { name: 'Minh' } },
  { id: 3, title: 'Review the dashboard PR', done: false, priority: 1, owner: { name: 'Huy' } },
];

app.get('/', function (req, res) {
  res.render('index', { appTitle: 'Task Board', user: { name: 'Lan' } });
});

app.get('/api/tasks', function (req, res) {
  var open = tasks.filter(function (t) { return !t.done; });
  console.log('open tasks', open.length, open);
  res.json({ tasks: tasks, total: tasks.length });
});

var port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log('Task Board on http://localhost:' + port);
});
