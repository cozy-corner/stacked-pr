const routes = [];

function register(path, handler) {
  routes.push({ path, handler });
}

module.exports = { routes, register };
