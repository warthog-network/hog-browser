#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# Settings → Install update. The helper lives outside the app directory so the
# polkit path has no spaces. Ubuntu's own dialog asks for the password.
HELPER_SRC='/opt/${sanitizedProductName}/resources/hog-preview-self-update'
POLICY_SRC='/opt/${sanitizedProductName}/resources/hog-preview-self-update.policy'
if [ -f "$HELPER_SRC" ] && [ -f "$POLICY_SRC" ]; then
  install -d /usr/libexec /usr/share/polkit-1/actions
  install -m 755 "$HELPER_SRC" /usr/libexec/hog-preview-self-update
  install -m 644 "$POLICY_SRC" /usr/share/polkit-1/actions/org.hog.BrowserChromiumPreview.self-update.policy
fi

# Phone start/stop of BzMiner. The helper only runs start_warthog.sh, and
# sudoers allows that one program with no password so a paired phone can
# reach it while nobody is at the computer.
MINER_SRC='/opt/${sanitizedProductName}/resources/hog-miner-ctl'
SUDOERS_SRC='/opt/${sanitizedProductName}/resources/hog-miner.sudoers'
if [ -f "$MINER_SRC" ] && [ -f "$SUDOERS_SRC" ]; then
  install -d /usr/libexec /etc/sudoers.d
  install -m 755 "$MINER_SRC" /usr/libexec/hog-miner-ctl
  if visudo -cf "$SUDOERS_SRC" >/dev/null; then
    install -m 440 "$SUDOERS_SRC" /etc/sudoers.d/hog-miner
  else
    echo "Hog preview: miner sudoers file was rejected and was not installed." >&2
  fi
fi

# Settings → Containers install buttons. Each helper takes no arguments.
# Ubuntu's own password dialog runs them. Hog never sees the password.
RES='/opt/${sanitizedProductName}/resources'
install_fixed() {
  src="$1"
  dest="$2"
  policy_src="$3"
  policy_dest="$4"
  if [ -f "$src" ] && [ -f "$policy_src" ]; then
    install -d /usr/libexec /usr/share/polkit-1/actions
    install -m 755 "$src" "$dest"
    install -m 644 "$policy_src" "$policy_dest"
  fi
}
install_fixed "$RES/hog-docker-engine-install" /usr/libexec/hog-docker-engine-install \
  "$RES/hog-docker-engine-install.policy" \
  /usr/share/polkit-1/actions/org.hog.BrowserChromiumPreview.docker-engine-install.policy
install_fixed "$RES/hog-docker-desktop-install" /usr/libexec/hog-docker-desktop-install \
  "$RES/hog-docker-desktop-install.policy" \
  /usr/share/polkit-1/actions/org.hog.BrowserChromiumPreview.docker-desktop-install.policy
install_fixed "$RES/hog-nvidia-toolkit-install" /usr/libexec/hog-nvidia-toolkit-install \
  "$RES/hog-nvidia-toolkit-install.policy" \
  /usr/share/polkit-1/actions/org.hog.BrowserChromiumPreview.nvidia-toolkit-install.policy
install_fixed "$RES/hog-docker-group" /usr/libexec/hog-docker-group \
  "$RES/hog-docker-group.policy" \
  /usr/share/polkit-1/actions/org.hog.BrowserChromiumPreview.docker-group.policy
