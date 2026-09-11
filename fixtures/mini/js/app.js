myApp.controller('demo-view-controller', ['$scope', 'Api', function (s, Api) {
  s.rows = [{ id: 1, label: 'dong dau', tags: ['a'] }];
  // Mang rong: KHONG suy duoc shape phan tu — chu y de test ca truong hop nay.
  s.emptyRows = [];
  s.form = { title: '', body: '' };
  s.busy = { saving: false, loading: false };
  s.total = 0;
  s.init = function () { s.rows = Api.list(); };
  s.pick = function (row) { s.selected = row; };
  s.onPick = function (file) { s.file = file; };
  s.$on('refresh', function () { s.init(); });
}]);

myApp.directive('pickFile', function () { return { restrict: 'A' }; });
myApp.component('myWidget', { bindings: { data: '<' }, controller: function () {} });
myApp.filter('money', function () { return function (v) { return v; }; });
myApp.factory('Api', function () { return { list: function () { return []; } }; });
myApp.directive('neverUsed', function () { return {}; });

// Bay false positive: KHONG duoc nhan la khai bao Angular.
var arr = [1, 2, 3].filter(Boolean);
var svc = something.service('not-angular');
