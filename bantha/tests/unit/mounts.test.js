const { ConfigLoader } = require('../../dist/config/loader');
const { MountPlanner } = require('../../dist/container/mounts');
const os = require('os');
const path = require('path');

const loader = new ConfigLoader(path.join(os.homedir(), '.bantha'));
const config = loader.loadAll();
const planner = new MountPlanner(config);

// 1. Current dir RW test
const cwd = '/tmp';
const plan1 = planner.planMounts(cwd);
console.assert(plan1.mounts.some(m => m.source === cwd && m.mode === 'rw'), 'Test 1 Failed: CWD not mounted RW');
console.assert(plan1.containerWorkdir === cwd, 'Test 1 Failed: containerWorkdir mismatch');

// 2. Protected ancestor test
const home = os.homedir();
const plan2 = planner.planMounts(home);
console.assert(!plan2.mounts.some(m => m.source === home), 'Test 2 Failed: Home mounted');

// 3. Blacklist test
config.filesystemMatcher.addExplicitDeny('!/tmp');
const plan3 = planner.planMounts(cwd);
console.assert(!plan3.mounts.some(m => m.source === cwd), 'Test 3 Failed: Blacklisted dir mounted');

// 4. Shared Hub & Subdirs Permission test
const customConfig = Object.assign({}, config, {
  filesystem: Object.assign({}, config.filesystem, {
    mounts: Object.assign({}, config.filesystem.mounts, {
      shared: {
        hub: {
          enabled: true,
          mode: 'rw',
          subdirs: {
            rules: 'ro',
            mcp: 'rw',
            skills: 'rw'
          }
        },
        agent_state: {
          enabled: true,
          mode: 'rw'
        }
      }
    })
  })
});
const customPlanner = new MountPlanner(customConfig);
const plan4 = customPlanner.planMounts('/tmp', 'hermes');

const sharedRootMount = plan4.mounts.find(m => m.destination === '/home/sandbox/.shared');
console.assert(sharedRootMount && sharedRootMount.type === 'bind' && sharedRootMount.source.endsWith('/shared'), 'Test 4 Failed: shared root not mounted as bind');

const hermesStateMount = plan4.mounts.find(m => m.destination === '/home/sandbox/.hermes');
console.assert(hermesStateMount && hermesStateMount.type === 'bind' && hermesStateMount.source.endsWith('/agents/hermes'), 'Test 4 Failed: hermes agent state not mounted directly to ~/.hermes');

console.log('ALL MOUNT PLANNER TESTS PASSED!');
