export default {
  id: 10,
  name: 'MongoDB (8.0 LTS)',
  category: 'database',
  is_daemon: true,
  runner: 'shell',
  extension: 'js',
  is_archived: false,
  source_file: 'query.js',
  compile_cmd: null,
  run_cmd: 'HOME=/tmp mongosh --norc --quiet /box/query.js',
  image: 'coderunner/mongodb:8.0',
  default_time_limit: 5,
  max_time_limit: 30,
  min_memory: 0,
  cmd: [
    'bash',
    '-c',
    'mkdir -p /box/data && mongod --dbpath /box/data --wiredTigerCacheSizeGB 0.25 --setParameter diagnosticDataCollectionEnabled=false --bind_ip 127.0.0.1 --fork --logpath /box/mongo.log && touch /box/.ready && exec sleep infinity',
  ],
};

