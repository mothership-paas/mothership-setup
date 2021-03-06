#!/usr/bin/env node

const Docker = require('dockerode');
const DockerMachine = require('docker-machine');
const Readline = require('readline');

const ora = require('ora');
const crypto = require('crypto');
const { table } = require('table');
const color = require('ansi-colors');
const { spawnSync } = require('child_process');

const MOTHERSHIP_LOGO = `                   \`:shmNmmmdhs:\`
                 \`sNNs:.    .:sNNo\`
                :mMh\` .:.  .-. \`yMm-
               .NMN..:NMN::NMN:..NMN.
          \`....sNNmdddmmmddmmmdddmNNs....\`
         +yyyyyyyyyyhhyhhyyhhyhhyhyyyyyyyy/
         \`+dMmNMmNMNNMNNMNNMmNMNNMmmMNmMd+\`
           \`/ssyyssyyhhyhyyhyhhyyssyyss/\`
                   \`+hmNNNNNNmh+\`
  __  __  ___ _____ _  _ ___ ___  ___ _  _ ___ ___
 |  \\/  |/ _ \\_   _| || | __| _ \\/ __| || |_ _| _ \\
 | |\\/| | (_) || | | __ | _||   /\\__ \\ __ || ||  _/
 |_|  |_|\\___/ |_| |_||_|___|_|_\\|___/_||_|___|_|`;
const MOTHERSHIP_NODE_NAME = 'mothership-paas';
const SWARM_MANAGER_NODE_NAME = 'mothership-swarm';

const dockerComposeContent = (domain, swarmManagerIp) => {
  const buf = crypto.randomBytes(256);
  const sessionSecret = buf.toString('hex');

  return `version: '3'

services:
  web:
    image: mothershippaas/mothership:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker
    environment:
      - NODE_ENV=production
      - SESSION_SECRET=${sessionSecret}
      - REDIS_HOST=redis
      - DB_USERNAME=postgres
      - DB_NAME=paas_development
      - DB_HOST=database
      - DB_PASSWORD=password
      - MOTHERSHIP_DOMAIN=${domain}
      - MOTHERSHIP_MANAGER_NAME=${SWARM_MANAGER_NODE_NAME}
      - MOTHERSHIP_MANAGER_IP=${swarmManagerIp}
    ports:
      - "443:443"
      - "80:80"
      - "3000:3000"

  database:
    image: postgres
    environment:
      - POSTGRES_DB=paas_development
      - POSTGRES_PASSWORD=password
    volumes:
      - db_data:/var/lib/postgresql/data

  redis:
    image: redis

volumes:
  db_data:`
};

const createDockerMachine = (name, accessToken) => {
  return new Promise((resolve, reject) => {
    const options = { 'digitalocean-access-token': accessToken };

    DockerMachine.create(name, 'digitalocean', options, (err) => {
      if (err) { reject(err); }
      resolve();
    });
  });
};

const getMachineIp = (name) => {
  return new Promise((resolve, reject) => {
    const machine = new DockerMachine(name);
    machine.inspect((err, result) => {
      if (err) reject(err);
      resolve(result.driver.ipAddress);
    });
  });
};

const sshMachine = (machine, command) => {
  return new Promise((resolve, reject) => {
    machine.ssh(command, (err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
};

const promptForInput = (prompt) => {
  return new Promise((resolve, reject) => {
    const readline = Readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.question(prompt + '\n> ', (input) => {
      readline.close();
      resolve(input);
    });
  });
};

// retryPromiseIfNeeded(fnReturningPromiseToAttempt, failedAttemptCb, maxTries)

// Takes a function, which when called returns a promise.
// If the promise resolves, retryPromiseIfNeeded resolves with the result.
// If the promise rejects, it will call the function again `maxTries` times.
// - After the promise rejects if `failedAttemptCb` is provided, it will be called
//   before reattempting the Promise.
// After we've reached the maximum number of retries we reject from the retry function.

const retryPromiseIfNeeded = async (fn, failedAttemptCb, maxTries = 5) => {
  return new Promise((resolve, reject) => {
    let attempt = 1;

    const attemptPromise = () => {
      fn().then((result) => {
        resolve(result);
      }).catch((err) => {
        if (attempt >= maxTries) {
          reject(err);
        } else {
          attempt += 1;
          if (failedAttemptCb) { failedAttemptCb(err); }
          attemptPromise();
        }
      });
    };

    attemptPromise();
  });
};

const main = async () => {
  let result;
  let loading;
  console.clear();
  console.log('');
  console.log(color.magenta(MOTHERSHIP_LOGO));
  console.log('');
  console.log(color.magenta('Automated Setup'));
  console.log('');

  // Prompt user for DO access token
  const accessToken = await promptForInput('Please enter your DigitalOcean access token:');
  // Prompt user for domain for PaaS
  const domain = await promptForInput("Please enter the domain you'd like your server to run on:");

  // ---

  console.log('');
  console.log('MOTHERSHIP SETUP');
  // Create droplet for PaaS server to run on

  loading = ora('Creating droplet for Mothership (this may take a few moments)...').start();
  await retryPromiseIfNeeded(() => {
    return createDockerMachine(MOTHERSHIP_NODE_NAME, accessToken)
  }, (err) => {
    spawnSync(`docker-machine rm -y ${MOTHERSHIP_NODE_NAME}`, [], { shell: true });
  }).then(() => {
    loading.succeed();
  }).catch(err => {
    loading.fail();
    console.log('Could not successfully create node on 5 attempts.');
    process.exit();
  });

  // Store IP address of Mothership node
  loading = ora('Getting IP address of Mothership node...');
  const mothershipIp = await getMachineIp(MOTHERSHIP_NODE_NAME);
  loading.succeed();

  // Switch docker context to Mothership node
  loading = ora('Logging into Mothership droplet...').start();
  const mothershipNode = new DockerMachine(MOTHERSHIP_NODE_NAME);
  loading.succeed();

  // Docker Machine and Docker Compose aren't installed by default on nodes you create with Docker Machine
  // TODO: either clean this up, or run our PaaS app without docker-compose?
  loading = ora('Installing docker-compose...').start();
  result = await sshMachine(mothershipNode, `sudo curl -L "https://github.com/docker/compose/releases/download/1.25.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose`);
  result = await sshMachine(mothershipNode, `sudo chmod +x /usr/local/bin/docker-compose`);
  loading.succeed();

  loading = ora('Installing docker-machine...').start();
  result = await sshMachine(mothershipNode, `base=https://github.com/docker/machine/releases/download/v0.16.2 &&
  curl -L $base/docker-machine-$(uname -s)-$(uname -m) >/tmp/docker-machine &&
  sudo mv /tmp/docker-machine /usr/local/bin/docker-machine &&
  chmod +x /usr/local/bin/docker-machine`);
  loading.succeed();

  // Create swarm manager node FROM Mothership node
  // (this way, all information about the swarm manager is stored on the Mothership node)
  console.log('');
  console.log('MOTHERSHIP SWARM SETUP');

  loading = ora('Creating droplet for Mothership swarm manager...').start();
  await retryPromiseIfNeeded(() => {
    return sshMachine(mothershipNode, `docker-machine create --driver digitalocean --digitalocean-access-token ${accessToken} ${SWARM_MANAGER_NODE_NAME}`);
  }, async (err) => {
    await sshMachine(mothershipNode, `docker-machine rm -y ${SWARM_MANAGER_NODE_NAME}`).catch(() => {});
  }).then(() => {
    loading.succeed();
  }).catch(err => {
    loading.fail();
    console.log('Could not successfully create node on 5 attempts.');
    process.exit();
  });

  // Get IP address of cluster manager
  loading = ora('Getting IP address...').start();
  let swarmManagerIp = await sshMachine(mothershipNode, `docker-machine ip ${SWARM_MANAGER_NODE_NAME}`);
  swarmManagerIp = swarmManagerIp.trim();
  loading.succeed();

  // Initialize Docker Swarm on swarm manager
  loading = ora('Initializing swarm...').start();
  result = await sshMachine(mothershipNode, `eval $(docker-machine env ${SWARM_MANAGER_NODE_NAME});docker swarm init --advertise-addr ${swarmManagerIp}`)
  loading.succeed();

  loading = ora('Creating overlay network...').start();
  result = await sshMachine(mothershipNode, `eval $(docker-machine env ${SWARM_MANAGER_NODE_NAME});docker network create --driver overlay proxy`);
  loading.succeed();

  // Create docker-flow-proxy-listener service
  loading = ora('Creating docker-flow-swarm-listener service...').start();
  result = await sshMachine(mothershipNode, `eval $(docker-machine env ${SWARM_MANAGER_NODE_NAME});docker service create --name swarm-listener \
--network proxy \
--mount "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock" \
-e DF_NOTIFY_CREATE_SERVICE_URL=http://proxy:8080/v1/docker-flow-proxy/reconfigure \
-e DF_NOTIFY_REMOVE_SERVICE_URL=http://proxy:8080/v1/docker-flow-proxy/remove \
--constraint 'node.role==manager' \
dockerflow/docker-flow-swarm-listener`);
  loading.succeed();

  // Create docker-flow-proxy service
  loading = ora('Creating docker-flow-proxy service...').start();
  result = await sshMachine(mothershipNode, `eval $(docker-machine env ${SWARM_MANAGER_NODE_NAME});docker service create --name proxy \
-p 80:80 \
-p 443:443 \
--network proxy \
-e LISTENER_ADDRESS=swarm-listener \
dockerflow/docker-flow-proxy`);
  loading.succeed();

  console.log('');
  console.log('MOTHERSHIP CONFIG AND START');

  // Install + Start PaaS to Mothership node
  loading = ora('Creating docker-compose.yml for Mothership...').start();
  result = await sshMachine(mothershipNode, `echo "${dockerComposeContent(domain, swarmManagerIp)}" >> docker-compose.yml`)
  loading.succeed();

  loading = ora('Starting Mothership server (Node.js + Postgres)...').start();
  result = await sshMachine(mothershipNode, `docker-compose up -d`);
  loading.succeed();

  // loading = ora('Creating database for Mothership...').start();
  // result = await sshMachine(mothershipNode, `docker-compose run web ./node_modules/.bin/sequelize db:create`);
  // loading.succeed();

  loading = ora('Running migrations for Mothership database...').start();
  result = await sshMachine(mothershipNode, `docker-compose run web ./node_modules/.bin/sequelize db:migrate`);
  loading.succeed();

  // Runs seed file
  loading = ora('Seeding Mothership\'s database...');
  result = await sshMachine(mothershipNode, `docker-compose run web ./node_modules/.bin/sequelize db:seed:all`);
  loading.succeed();

  // We're now done! Prints info on what needs added to their DNS and the IP where the Node.js app lives.
  console.log('');
  console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  console.log('~~ Mothership installer complete! ~~');
  console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  console.log('');
  console.log('Note: To finish configuration you\'ll need to add the');
  console.log('following resource records to your DNS provider:');

  const output = [
    ["Name", "Type", "IP Address"],
    ["@", "A", `${swarmManagerIp}`],
    ["*", "A", `${swarmManagerIp}`],
    ["mothership", "A", `${mothershipIp}`]
  ];

  console.log(table(output));
  console.log(`After adding these resource records visit Mothership online: http://mothership.${domain}`);

  process.exit();
};

main();
