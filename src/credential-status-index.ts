import {
  BaseCredentialStatusManager,
  CredentialStatusConfigData,
  CredentialStatusLogData,
  CredentialStatusManagerService,
  VisibilityLevel,
  composeStatusCredential
} from './credential-status-base';
import {
  GithubCredentialStatusManager,
  GithubCredentialStatusManagerOptions
} from './credential-status-github';
import {
  GitlabCredentialStatusManager,
  GitlabCredentialStatusManagerOptions
} from './credential-status-gitlab';
import { signCredential, getSigningMaterial } from './helpers';

// Type definition for base options of createStatusListManager function input
interface StatusListManagerBaseOptions {
  service: CredentialStatusManagerService;
}

// Type definition for createStatusListManager function input
type StatusListManagerOptions = StatusListManagerBaseOptions &
  (GithubCredentialStatusManagerOptions | GitlabCredentialStatusManagerOptions);

// creates credential status list manager
export async function createStatusListManager(options: StatusListManagerOptions)
: Promise<BaseCredentialStatusManager> {
  const {
    service,
    repoName='credential-status',
    metaRepoName='credential-status-metadata',
    repoOrgName,
    repoVisibility=VisibilityLevel.Public,
    accessToken,
    didMethod,
    didSeed,
    didWebUrl,
    signUserCredential=false,
    signStatusCredential=false
  } = options;
  let statusManager: BaseCredentialStatusManager;
  switch (service) {
    case CredentialStatusManagerService.Github:
      statusManager = new GithubCredentialStatusManager({
        repoName,
        metaRepoName,
        repoOrgName,
        repoVisibility,
        accessToken,
        didMethod,
        didSeed,
        didWebUrl,
        signUserCredential,
        signStatusCredential
      });
      break;
    case CredentialStatusManagerService.Gitlab: {
      const { repoOrgId } = options as GitlabCredentialStatusManagerOptions;
      statusManager = new GitlabCredentialStatusManager({
        repoName,
        metaRepoName,
        repoOrgName,
        repoOrgId,
        repoVisibility,
        accessToken,
        didMethod,
        didSeed,
        didWebUrl,
        signUserCredential,
        signStatusCredential
      });
      break;
    }
    default:
      throw new Error(
        '"service" must be one of the following values: ' +
        `${Object.values(CredentialStatusManagerService).map(v => `'${v}'`).join(', ')}.`
      );
  }

  // retrieve signing material
  const { issuerDid } = await getSigningMaterial({
    didMethod,
    didSeed,
    didWebUrl
  });

  // setup status credential
  const credentialStatusUrl = statusManager.getCredentialStatusUrl();
  const repoExists = await statusManager.statusRepoExists();
  if (!repoExists) {
    // create status repo
    await statusManager.createStatusRepo();

    // create and persist status config
    const listId = statusManager.generateStatusListId();
    const configData: CredentialStatusConfigData = {
      credentialsIssued: 0,
      latestList: listId
    };
    await statusManager.createConfigData(configData);

    // create and persist status log
    const logData: CredentialStatusLogData = [];
    await statusManager.createLogData(logData);

    // create status credential
    const statusCredentialId = `${credentialStatusUrl}/${listId}`;
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
    await statusManager.createStatusData(statusCredential);

    // setup credential status website
    await statusManager.deployCredentialStatusWebsite();
  } else {
    // sync status repo state
    await statusManager.syncStatusRepoState();
  }

  return statusManager;
}
