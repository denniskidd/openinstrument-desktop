const { notarize } = require('electron-notarize');

exports.default = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;

  console.log('🔐 Notarizing with notarytool...');

  await notarize({
    appBundleId: 'edu.jh.openrequest',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASS,
    tool: 'notarytool',
    teamId: process.env.APPLE_TEAM_ID, // <- must be added to your GitHub Secrets
  });
};