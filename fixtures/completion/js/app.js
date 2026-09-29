// Fixture for .scratch/template-completion: nested controllers, controller-as, a component,
// an attribute directive, filters and services of every shape.
var app = angular.module('app', []);

app.controller('OuterCtrl', function ($scope) {
  $scope.user = { name: 'a', roles: ['x'] };
  $scope.logout = function () {};
});

app.controller('InnerCtrl', ['$scope', 'UserService', 'Settings', function (s, us, settings) {
  s.items = [{ id: 1, title: 't' }];
  s.form = { email: '' };
  s.form.extra = true;
  s.load = function (page) { us.fetch(page); };
}]);

app.controller('FormCtrl', function () {
  var vm = this;
  vm.model = { email: '', age: 0 };
  vm.submit = function () {};
});

app.component('userCard', {
  bindings: { user: '<', onSelect: '&' },
  templateUrl: 'views/card.html',
  controller: function () {
    this.expanded = false;
    this.toggle = function () {};
  },
});

app.directive('pickFile', function () {
  return { restrict: 'A', scope: { onPick: '&' } };
});

app.filter('money', function () {
  return function (v) { return v; };
});

app.factory('UserService', function ($http) {
  var cache = {};
  function fetch(page) { return $http.get('/u?p=' + page); }
  return { fetch: fetch, save: function (u) {}, cache: cache, meta: { total: 0 } };
});

app.service('Clock', function () {
  var self = this;
  this.now = function () { return Date.now(); };
  self.zone = 'UTC';
});

app.constant('Settings', { pageSize: 20, theme: { dark: false } });
