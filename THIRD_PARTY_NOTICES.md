# Third-party notices

The production extension includes these locally bundled dependencies:

- **NSFWJS 4.3.0** and its MobileNetV2Mid model assets ? MIT License. Copyright Infinite Red, Inc. Source: <https://github.com/infinitered/nsfwjs>
- **TensorFlow.js 4.22.0** ? Apache License 2.0. Copyright The TensorFlow Authors. Source: <https://github.com/tensorflow/tfjs>

The complete corresponding license texts are available in each dependency's npm package and upstream repository. No dependency is loaded remotely at runtime.

## Adult-domain data

The compressed data in `data/adult-domains.txt.gz` is derived from [The Block List Project pornography list](https://github.com/blocklistproject/Lists), released under the **Unlicense**. Its complete license is included in `data/ADULT_LIST_LICENSE.txt`. `data/adult-list.json` records the exact source revision, source URL, SHA-256 hashes, entry counts, and exclusions. Changes: validate domain syntax, exclude selected mixed-content parent domains and public suffixes, deduplicate, remove redundant children, sort, and gzip. This list is bundled; it is not fetched remotely while browsing.
