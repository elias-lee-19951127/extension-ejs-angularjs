angular.module('app', []).controller('ListCtrl', function ($scope, $http) {
  $scope.rows = [];
  $http.get('/rows').then(function (res) { $scope.rows = res.data; });
});
