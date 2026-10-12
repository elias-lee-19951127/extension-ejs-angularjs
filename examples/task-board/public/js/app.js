// AngularJS 1.x, ES5 — the kind of code EJS + AngularJS Navigator is built for.
var app = angular.module('taskBoard', []);

app.factory('TaskService', ['$http', function ($http) {
  var cache = { tasks: [] };
  function list() {
    return $http.get('/api/tasks').then(function (res) {
      cache.tasks = res.data.tasks;
      return res.data;
    });
  }
  function save(task) { return $http.put('/api/tasks/' + task.id, task); }
  return { list: list, save: save, cache: cache };
}]);

app.controller('BoardCtrl', ['$scope', 'TaskService', function ($scope, TaskService) {
  $scope.query = '';
  $scope.busy = false;
  $scope.tasks = [];
  $scope.stats = { total: 0, updatedAt: null };

  $scope.openCount = function () {
    return $scope.tasks.filter(function (t) { return !t.done; }).length;
  };

  $scope.reload = function () {
    $scope.busy = true;
    TaskService.list().then(function (data) {
      $scope.tasks = data.tasks;
      $scope.stats = { total: data.total, updatedAt: new Date() };
      console.log('loaded', $scope.tasks);
      $scope.busy = false;
    });
  };

  $scope.reload();
}]);

app.controller('TaskListCtrl', ['TaskService', function (TaskService) {
  var vm = this;
  vm.toggle = function (task) {
    task.done = !task.done;
    TaskService.save(task);
  };
}]);

app.component('taskCard', {
  bindings: { task: '<', onToggle: '&' },
  templateUrl: 'views/task-card.html',
  controller: function () {
    this.expanded = false;
    this.priorityLabel = function () {
      return ['low', 'normal', 'high'][this.task.priority - 1];
    };
  },
});

app.filter('ago', function () {
  return function (date) {
    if (!date) return 'never';
    var s = Math.round((Date.now() - date) / 1000);
    return s < 60 ? 'just now' : Math.round(s / 60) + ' min ago';
  };
});
