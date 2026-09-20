// Demo for "Log at runtime" (.scratch/log-variable/spec.md, docs/kien-truc.md 5.3.3). Runs on plain
// Node: the `angular`
// below is a stand-in, so the file is at once a controller the index understands and a program
// you can start with `node --inspect`.
var angular = {
  module: function () {
    return {
      controller: function (name, fn) {
        fn({}, { get: fakeGet });
        return this;
      },
    };
  },
};

/** A fake $http.get: answers a different shape on each call, to show the hover keeping up. */
var calls = 0;
function fakeGet(url) {
  var tick = calls++ % 3;
  var rows =
    tick === 0
      ? [{ id: 1, title: 'Sensor A', owner: { id: 7, name: 'ops' }, tags: ['alarm'] }]
      : tick === 1
        ? [{ id: 2, title: 'Sensor B', owner: { id: 8, name: 'field' }, tags: [] }]
        : [];
  var selected = tick === 2 ? null : { id: 9, label: 'Zone ' + tick };
  return { then: function (cb) { cb({ data: { rows: rows, selected: selected } }); } };
}

angular.module('demoApp', []).controller('DemoListCtrl', function ($scope, $http) {
  $scope.title = 'Demo list';
  $scope.rows = [];

  $scope.reload = function () {
    $http.get('/rows').then(function (res) {
      // The index cannot type either of these: hover them and the link appears.
      $scope.rows = res.data.rows;
      $scope.selected = res.data.selected;
      // Logged so the inline value can show what an expanded object looks like.
      console.log('rows', $scope.rows);
    });
  };

  setInterval($scope.reload, 1000);
  $scope.reload();
});
