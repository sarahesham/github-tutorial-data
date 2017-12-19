import "babel-polyfill";
import mysql from 'mysql';
import AWS from 'aws-sdk';
import axios from 'axios';
import urlparse from 'url-parse';
import uuidv4 from 'uuid/v4';
import { applyMiddleware, createStore } from 'redux';
import createSagaMiddleware from 'redux-saga';
import githubSaga from './github-saga';
import reducers from './reducers';
import deferralMiddleware from './deferral-middleware';
import endScriptMiddleware from './end-script-middleware';
import {
  putRemaining,
  putEnv,
  putConnection,
  getTasks,
  initialAction
} from './actions';
import {
  sqlPromise
} from './util';
import Raven from 'raven';

export default async () => {
  Raven.config(process.env.RAVEN_URL).install();
  const connection = mysql.createConnection({
    host: process.env.MY_SQL_HOST,
    port: process.env.MY_SQL_PORT,
    user: process.env.MY_SQL_USERNAME,
    password: process.env.MY_SQL_PASSWORD,
    database: process.env.MY_SQL_DATABASE,
    ssl: process.env.MY_SQL_SSL,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  // try opening the connection
  try {
    await new Promise((resolve, reject) => connection.connect(e => e ? reject(e) : resolve()));
  } catch (e) {
    Raven.captureException(e);
    connection.destroy();
    return;
  }
  try {
    const limit = await axios(`${process.env.GITHUB_API}/rate_limit`);
    const shouldStop = await new Promise((resolve, reject) => new AWS.Lambda({region: 'us-east-1'}).invoke({
      InvocationType: 'RequestResponse',
      FunctionName: process.env.SHOULD_STOP_FUNCTION,
      Payload: JSON.stringify({})
    }, (e, r) => e ? reject(e) : resolve(r)));
    if (JSON.parse(shouldStop.Payload)) {
      return;
    }
    if (process.env.IS_INITIAL && JSON.parse(process.env.IS_INITIAL)) {
      await sqlPromise(connection, `SET tx_isolation = 'READ-COMMITTED';`);
      await sqlPromise(connection, `SET GLOBAL tx_isolation = 'READ-COMMITTED';`);
      await sqlPromise(connection, 'DROP TABLE IF EXISTS commits;');
      await sqlPromise(connection, 'DROP TABLE IF EXISTS repos;');
      await sqlPromise(connection, 'DROP TABLE IF EXISTS deferred;');
      await sqlPromise(connection, 'DROP TABLE IF EXISTS executing;');
      await sqlPromise(connection, 'CREATE TABLE commits (sha VARCHAR(40) PRIMARY KEY, repo_id INT, author_name VARCHAR(128), author_email VARCHAR(128), author_date BIGINT, committer_name VARCHAR(128), committer_email VARCHAR(128), committer_date BIGINT, author_login VARCHAR(128), author_id INT, committer_login VARCHAR(128), committer_id INT, additions INT, deletions INT, total INT, test_additions INT, test_deletions INT, test_changes INT);'); // create commit table
      await sqlPromise(connection, 'CREATE TABLE repos (id INT PRIMARY KEY, owner_login VARCHAR(128), owner_id INT, name VARCHAR(128), full_name VARCHAR(128), language VARCHAR(128), forks_count INT, stargazers_count INT, watchers_count INT, subscribers_count INT, size INT, has_issues INT, has_wiki INT, has_pages INT, has_downloads INT, pushed_at BIGINT, created_at BIGINT, updated_at BIGINT);'); // create repo table
      await sqlPromise(connection, 'CREATE TABLE deferred (id VARCHAR(36) PRIMARY KEY, action VARCHAR(32), json TEXT);'); // create deferred table
      await sqlPromise(connection, 'CREATE TABLE executing (id VARCHAR(36) PRIMARY KEY);'); // a global state machine for the number of executing servers
    }
    const sagaMiddleware = createSagaMiddleware();
    const store = applyMiddleware(endScriptMiddleware, deferralMiddleware, sagaMiddleware)(createStore)(reducers);
    sagaMiddleware.run(githubSaga);
    store.dispatch(putConnection(connection));
    store.dispatch(putEnv(process.env));
    store.dispatch(putRemaining(parseInt(limit.data.rate.remaining)));
    console.log(`starting batch with ${limit.data.rate.remaining}`);
    if (process.env.IS_INITIAL && JSON.parse(process.env.IS_INITIAL)) {   
      store.dispatch(initialAction(parseInt(process.env.START_REPO)));
    } else {
      store.dispatch(getTasks(limit.data.rate.remaining, true));
    }
  } catch (e) {
    console.error(e);
    Raven.captureException(e);
    process.exit(1);
  }
}