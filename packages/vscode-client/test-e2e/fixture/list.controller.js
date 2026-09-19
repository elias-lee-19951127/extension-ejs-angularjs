angular.module('app', []).controller('ListCtrl', function ($scope, $http) {
  $http.get('/rows').then(function (res) { $scope.rows = res.data; });
});
