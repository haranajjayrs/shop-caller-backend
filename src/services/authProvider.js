const { getFirebaseAdmin } = require("../config/firebaseAdmin");

/**
 * Thin wrapper over Firebase Admin auth so the rest of the code (and tests)
 * don't depend on Firebase directly.
 */
let provider = {
  async createUser({ email, password, displayName }) {
    const rec = await getFirebaseAdmin().auth().createUser({ email, password, displayName });
    return { uid: rec.uid };
  },
  async updateUser(uid, fields) {
    await getFirebaseAdmin().auth().updateUser(uid, fields);
  },
  async deleteUser(uid) {
    await getFirebaseAdmin().auth().deleteUser(uid);
  },
  async revokeTokens(uid) {
    await getFirebaseAdmin().auth().revokeRefreshTokens(uid);
  },
};

module.exports = {
  createUser: (...a) => provider.createUser(...a),
  updateUser: (...a) => provider.updateUser(...a),
  deleteUser: (...a) => provider.deleteUser(...a),
  revokeTokens: (...a) => provider.revokeTokens(...a),
  /** Test hook */
  setProvider: (p) => {
    provider = p;
  },
};
