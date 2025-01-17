/*!
 * Copyright (c) 2023 Digital Credentials Consortium. All rights reserved.
 */
import { CONTEXT_URL_V1 } from '@digitalbazaar/vc-status-list-context';
import { VerifiableCredential } from '@digitalcredentials/vc-data-model';
import { createCredential, createList, decodeList } from '@digitalcredentials/vc-status-list';
import { Mutex } from 'async-mutex';
import { v4 as uuid } from 'uuid';
import {
  DidMethod,
  getDateString,
  getSigningMaterial,
  signCredential
} from './helpers.js';

// Number of credentials tracked in a list
const CREDENTIAL_STATUS_LIST_SIZE = 100000;

// Credential status type
const CREDENTIAL_STATUS_TYPE = 'StatusList2021Entry';

// Name of credential status branch
export const CREDENTIAL_STATUS_REPO_BRANCH_NAME = 'main';

// Credential status resource names
export const CREDENTIAL_STATUS_CONFIG_FILE = 'config.json';
export const CREDENTIAL_STATUS_LOG_FILE = 'log.json';

// Credential status manager source control service
export enum CredentialStatusManagerService {
  Github = 'github',
  Gitlab = 'gitlab'
}

// Actions applied to credentials and tracked in status log
export enum SystemFile {
  Config = 'config',
  Log = 'log',
  Status = 'status'
}

// States of credential resulting from caller actions and tracked in status log
export enum CredentialState {
  Active = 'active',
  Revoked = 'revoked'
}

// Type definition for credential status config file
export interface CredentialStatusConfigData {
  credentialsIssued: number;
  latestList: string;
}

// Type definition for credential status log entry
export interface CredentialStatusLogEntry {
  timestamp: string;
  credentialId: string;
  credentialIssuer: string;
  credentialSubject?: string;
  credentialState: CredentialState;
  verificationMethod: string;
  statusListId: string;
  statusListIndex: number;
}

// Type definition for credential status log
export type CredentialStatusLogData = CredentialStatusLogEntry[];

// Type definition for composeStatusCredential function input
interface ComposeStatusCredentialOptions {
  issuerDid: string;
  credentialId: string;
  statusList?: any;
  statusPurpose?: string;
}

// Type definition for embedCredentialStatus method input
interface EmbedCredentialStatusOptions {
  credential: any;
  statusPurpose?: string;
}

// Type definition for embedCredentialStatus method output
interface EmbedCredentialStatusResult {
  credential: any;
  newList?: string;
}

// Type definition for updateStatus method input
interface UpdateStatusOptions {
  credentialId: string;
  credentialStatus: CredentialState;
}

// Type definition for BaseCredentialStatusManager constructor method input
export interface BaseCredentialStatusManagerOptions {
  repoName: string;
  metaRepoName: string;
  repoAccessToken: string;
  metaRepoAccessToken: string;
  didMethod: DidMethod;
  didSeed: string;
  didWebUrl?: string;
  signUserCredential?: boolean;
  signStatusCredential?: boolean;
}

// Minimal set of options required for configuring BaseCredentialStatusManager
export const BASE_MANAGER_REQUIRED_OPTIONS: Array<keyof BaseCredentialStatusManagerOptions> = [
  'repoName',
  'metaRepoName',
  'repoAccessToken',
  'metaRepoAccessToken',
  'didMethod',
  'didSeed'
];

// Base class for credential status managers
export abstract class BaseCredentialStatusManager {
  protected readonly repoName: string;
  protected readonly metaRepoName: string;
  protected readonly repoAccessToken: string;
  protected readonly metaRepoAccessToken: string;
  protected readonly didMethod: DidMethod;
  protected readonly didSeed: string;
  protected readonly didWebUrl: string;
  protected readonly signUserCredential: boolean;
  protected readonly signStatusCredential: boolean;
  protected readonly lock: Mutex;

  constructor(options: BaseCredentialStatusManagerOptions) {
    const {
      repoName,
      metaRepoName,
      repoAccessToken,
      metaRepoAccessToken,
      didMethod,
      didSeed,
      didWebUrl,
      signUserCredential,
      signStatusCredential
    } = options;
    this.repoName = repoName;
    this.metaRepoName = metaRepoName;
    this.repoAccessToken = repoAccessToken;
    this.metaRepoAccessToken = metaRepoAccessToken;
    this.didMethod = didMethod;
    this.didSeed = didSeed;
    this.didWebUrl = didWebUrl ?? '';
    this.signUserCredential = signUserCredential ?? false;
    this.signStatusCredential = signStatusCredential ?? false;
    this.lock = new Mutex();
  }

  // generates new status list ID
  generateStatusListId(): string {
    return Math.random().toString(36).substring(2, 12).toUpperCase();
  }

  // embeds status into credential
  async embedCredentialStatus({ credential, statusPurpose = 'revocation' }: EmbedCredentialStatusOptions): Promise<EmbedCredentialStatusResult> {
    // ensure that credential has ID
    if (!credential.id) {
      // Note: This assumes that uuid will never generate an ID that
      // conflicts with an ID that has already been tracked in the log
      credential.id = uuid();
    }

    // find latest relevant log entry for credential with given ID
    const logData: CredentialStatusLogData = await this.readLogData();
    logData.reverse();
    const logEntry = logData.find((entry) => {
      return entry.credentialId === credential.id;
    });

    // do not allocate new status list entry if ID is already being tracked
    if (logEntry) {
      // retrieve relevant log data
      const { statusListId: logStatusListId, statusListIndex } = logEntry;

      // attach credential status
      const statusUrl = this.getCredentialStatusUrl();
      const statusListCredential = `${statusUrl}/${logStatusListId}`;
      const statusListId = `${statusListCredential}#${statusListIndex}`;
      const credentialStatus = {
        id: statusListId,
        type: CREDENTIAL_STATUS_TYPE,
        statusPurpose,
        statusListIndex,
        statusListCredential
      };

      return {
        credential: {
          ...credential,
          credentialStatus,
          '@context': [...credential['@context'], CONTEXT_URL_V1]
        }
      };
    }

    // retrieve status config data
    const configData = await this.readConfigData();
    let { credentialsIssued, latestList } = configData;

    // allocate new status list entry if ID is not yet being tracked
    let newList;
    if (credentialsIssued >= CREDENTIAL_STATUS_LIST_SIZE) {
      latestList = this.generateStatusListId();
      newList = latestList;
      credentialsIssued = 0;
    }
    credentialsIssued++;

    // update status config data
    configData.credentialsIssued = credentialsIssued;
    configData.latestList = latestList;
    await this.updateConfigData(configData);

    // attach credential status
    const statusUrl = this.getCredentialStatusUrl();
    const statusListCredential = `${statusUrl}/${latestList}`;
    const statusListIndex = credentialsIssued;
    const statusListId = `${statusListCredential}#${statusListIndex}`;
    const credentialStatus = {
      id: statusListId,
      type: CREDENTIAL_STATUS_TYPE,
      statusPurpose,
      statusListIndex,
      statusListCredential
    };

    return {
      credential: {
        ...credential,
        credentialStatus,
        '@context': [...credential['@context'], CONTEXT_URL_V1]
      },
      newList
    };
  }

  // allocates status for credential in race-prone manner
  async allocateStatusUnsafe(credential: VerifiableCredential): Promise<VerifiableCredential> {
    // report error for compact JWT credentials
    if (typeof credential === 'string') {
      throw new Error('This library does not support compact JWT credentials.');
    }

    // attach status to credential
    let {
      credential: credentialWithStatus,
      newList
    } = await this.embedCredentialStatus({ credential });

    // retrieve signing material
    const {
      didMethod,
      didSeed,
      didWebUrl,
      signUserCredential,
      signStatusCredential
    } = this;
    const {
      issuerDid,
      verificationMethod
    } = await getSigningMaterial({
      didMethod,
      didSeed,
      didWebUrl
    });

    // create new status credential only if a new list was created
    if (newList) {
      // create status credential
      const credentialStatusUrl = this.getCredentialStatusUrl();
      const statusCredentialId = `${credentialStatusUrl}/${newList}`;
      let statusCredential = await composeStatusCredential({
        issuerDid,
        credentialId: statusCredentialId
      });

      // sign status credential if necessary
      if (signStatusCredential) {
        statusCredential = await signCredential({
          credential: statusCredential,
          didMethod,
          didSeed,
          didWebUrl
        });
      }

      // create and persist status data
      await this.createStatusData(statusCredential);
    }

    if (signUserCredential) {
      // sign credential
      credentialWithStatus = await signCredential({
        credential: credentialWithStatus,
        didMethod,
        didSeed,
        didWebUrl
      });
    }

    // add new entry to status log
    const {
      id: credentialStatusId,
      statusListCredential,
      statusListIndex
    } = credentialWithStatus.credentialStatus;

    // retrieve status list ID from status credential URL
    const statusListId = statusListCredential.split('/').slice(-1).pop();
    const statusLogEntry: CredentialStatusLogEntry = {
      timestamp: getDateString(),
      credentialId: credential.id ?? credentialStatusId,
      credentialIssuer: issuerDid,
      credentialSubject: credential.credentialSubject?.id,
      credentialState: CredentialState.Active,
      verificationMethod,
      statusListId,
      statusListIndex
    };
    const statusLogData = await this.readLogData();
    statusLogData.push(statusLogEntry);
    await this.updateLogData(statusLogData);

    return credentialWithStatus;
  }

  // allocates status for credential in thread-safe manner
  async allocateStatus(credential: VerifiableCredential): Promise<VerifiableCredential> {
    const release = await this.lock.acquire();
    try {
      const result = await this.allocateStatusUnsafe(credential);
      return result;
    } finally {
      release();
    }
  }

  // updates status of credential in race-prone manner
  async updateStatusUnsafe({
    credentialId,
    credentialStatus
  }: UpdateStatusOptions): Promise<VerifiableCredential> {
    // find latest relevant log entry for credential with given ID
    const logData: CredentialStatusLogData = await this.readLogData();
    logData.reverse();
    const logEntry = logData.find((entry) => {
      return entry.credentialId === credentialId;
    });

    // unable to find credential with given ID
    if (!logEntry) {
      throw new Error(`Unable to find credential with given ID "${credentialId}"`);
    }

    // retrieve relevant log data
    const {
      credentialSubject,
      statusListId,
      statusListIndex
    } = logEntry;

    // retrieve signing material
    const {
      didMethod,
      didSeed,
      didWebUrl,
      signStatusCredential
    } = this;
    const {
      issuerDid,
      verificationMethod
    } = await getSigningMaterial({
      didMethod,
      didSeed,
      didWebUrl
    });

    // retrieve status credential
    const statusCredentialBefore = await this.readStatusData();

    // report error for compact JWT credentials
    if (typeof statusCredentialBefore === 'string') {
      throw new Error('This library does not support compact JWT credentials.');
    }

    // update status credential
    const statusCredentialListEncodedBefore = statusCredentialBefore.credentialSubject.encodedList;
    const statusCredentialListDecoded = await decodeList({
      encodedList: statusCredentialListEncodedBefore
    });
    switch (credentialStatus) {
      case CredentialState.Active:
        statusCredentialListDecoded.setStatus(statusListIndex, false); // active credential is represented as 0 bit
        break;
      case CredentialState.Revoked:
        statusCredentialListDecoded.setStatus(statusListIndex, true); // revoked credential is represented as 1 bit
        break;
      default:
        throw new Error(
          '"credentialStatus" must be one of the following values: ' +
          `${Object.values(CredentialState).map(v => `'${v}'`).join(', ')}.`
        );
    }
    const credentialStatusUrl = this.getCredentialStatusUrl();
    const statusCredentialId = `${credentialStatusUrl}/${statusListId}`;
    let statusCredential = await composeStatusCredential({
      issuerDid,
      credentialId: statusCredentialId,
      statusList: statusCredentialListDecoded
    });

    // sign status credential if necessary
    if (signStatusCredential) {
      statusCredential = await signCredential({
        credential: statusCredential,
        didMethod,
        didSeed,
        didWebUrl
      });
    }

    // persist status credential
    await this.updateStatusData(statusCredential);

    // add new entries to status log
    const statusLogData = await this.readLogData();
    const statusLogEntry: CredentialStatusLogEntry = {
      timestamp: getDateString(),
      credentialId,
      credentialIssuer: issuerDid,
      credentialSubject,
      credentialState: credentialStatus,
      verificationMethod,
      statusListId,
      statusListIndex
    };
    statusLogData.push(statusLogEntry);
    await this.updateLogData(statusLogData);

    return statusCredential;
  }

  // updates status of credential in thread-safe manner
  async updateStatus({
    credentialId,
    credentialStatus
  }: UpdateStatusOptions): Promise<VerifiableCredential> {
    const release = await this.lock.acquire();
    try {
      const result = await this.updateStatusUnsafe({ credentialId, credentialStatus });
      return result;
    } finally {
      release();
    }
  }

  // checks status of credential
  async checkStatus(credentialId: string): Promise<CredentialStatusLogEntry> {
    // find latest relevant log entry for credential with given ID
    const logData: CredentialStatusLogData = await this.readLogData();
    logData.reverse();
    const logEntry = logData.find((entry) => {
      return entry.credentialId === credentialId;
    }) as CredentialStatusLogEntry;

    // unable to find credential with given ID
    if (!logEntry) {
      throw new Error(`Unable to find credential with given ID "${credentialId}"`);
    }

    return logEntry;
  }

  // retrieves credential status URL
  abstract getCredentialStatusUrl(): string;

  // deploys website to host credential status management resources
  async deployCredentialStatusWebsite(): Promise<void> {};

  // checks if caller has authority to update status based on status repo access token
  abstract hasStatusAuthority(repoAccessToken: string): Promise<boolean>;

  // checks if status repos exist
  abstract statusReposExist(): Promise<boolean>;

  // checks if status repos are empty
  abstract statusReposEmpty(): Promise<boolean>;

  // checks if status repos are properly configured
  async statusReposProperlyConfigured(): Promise<boolean> {
    try {
      // retrieve config data
      const configData = await this.readConfigData();
      const { credentialsIssued, latestList: statusListId } = configData;
      const credentialStatusUrl = this.getCredentialStatusUrl();
      const statusCredentialId = `${credentialStatusUrl}/${statusListId}`;

      // retrieve log data
      const logData = await this.readLogData();

      // retrieve status credential
      const statusListData = await this.readStatusData();

      // ensure status data has proper type
      if (typeof statusListData === 'string') {
        return false;
      }

      // ensure status credential is well formed
      const hasProperStatusListId = statusListData.id?.endsWith(statusListId) ?? false;
      const hasProperStatusListType = statusListData.type.includes('StatusList2021Credential');
      const hasProperStatusListSubId = statusListData.credentialSubject.id?.startsWith(statusCredentialId) ?? false;
      const hasProperStatusListSubType = statusListData.credentialSubject.type === 'StatusList2021';
      const hasProperStatusListSubStatusPurpose = statusListData.credentialSubject.statusPurpose === 'revocation';

      // ensure log data is well formed
      const hasProperLogDataType = Array.isArray(logData);
      const credentialIds = logData.map((value) => {
        return value.credentialId;
      });
      const credentialIdsUnique = credentialIds.filter((value, index, array) => {
        return array.indexOf(value) === index;
      });
      const hasProperLogEntries = credentialIdsUnique.length === credentialsIssued;

      // ensure that all checks pass
      return hasProperStatusListId &&
             hasProperStatusListType &&
             hasProperStatusListSubId &&
             hasProperStatusListSubType &&
             hasProperStatusListSubStatusPurpose &&
             hasProperLogDataType &&
             hasProperLogEntries;
    } catch (error) {
      return false;
    }
  }

  // retrieves data from status repo
  abstract readRepoData(): Promise<any>;

  // retrieves data from status metadata repo
  abstract readMetaRepoData(): Promise<any>;

  // creates data in config file
  abstract createConfigData(data: CredentialStatusConfigData): Promise<void>;

  // retrieves data from config file
  abstract readConfigData(): Promise<CredentialStatusConfigData>;

  // updates data in config file
  abstract updateConfigData(data: CredentialStatusConfigData): Promise<void>;

  // creates data in log file
  abstract createLogData(data: CredentialStatusLogData): Promise<void>;

  // retrieves data from log file
  abstract readLogData(): Promise<CredentialStatusLogData>;

  // updates data in log file
  abstract updateLogData(data: CredentialStatusLogData): Promise<void>;

  // creates data in status file
  abstract createStatusData(data: VerifiableCredential): Promise<void>;

  // retrieves data from status file
  abstract readStatusData(): Promise<VerifiableCredential>;

  // updates data in status file
  abstract updateStatusData(data: VerifiableCredential): Promise<void>;
}

// composes StatusList2021Credential
export async function composeStatusCredential({
  issuerDid,
  credentialId,
  statusList,
  statusPurpose = 'revocation'
}: ComposeStatusCredentialOptions): Promise<any> {
  // determine whether or not to create a new status list
  if (!statusList) {
    statusList = await createList({ length: CREDENTIAL_STATUS_LIST_SIZE });
  }

  // create status credential
  const issuanceDate = getDateString();
  let credential = await createCredential({
    id: credentialId,
    list: statusList,
    statusPurpose
  });
  credential = {
    ...credential,
    issuer: issuerDid,
    issuanceDate
  };

  return credential;
}
