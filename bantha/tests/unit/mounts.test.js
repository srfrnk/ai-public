const { ConfigLoader } = require('../../dist/config/loader');
const { MountPlanner } = require('../../dist/container/mounts');
const os = require('os');
const path = require('path');

const loader = new ConfigLoader(path.join(os.homedir(), '.agent-sandbox'));
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

console.log('ALL MOUNT PLANNER TESTS PASSED!');
