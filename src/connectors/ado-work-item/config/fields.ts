// Default ADO field configuration
//
// Only standard System.* fields are hardcoded here. Template fields
// (Microsoft.VSTS.*) live in config.json (repo or user level) under
// the "adoFields" key.

import type { AdoFieldConfig, AdoLabeledField } from "./types.js";

/** Standard system fields — hardcoded, universal across all ADO processes. */
export const DEFAULT_FIELD_CONFIG: AdoFieldConfig = {
  skipFields: {
    system: [
      "System.Id",
      "System.Rev",
      "System.Watermark",
      "System.PersonId",
      "System.AreaId",
      "System.IterationId",
      "System.NodeName",
      "System.TeamProject",
      "System.AuthorizedAs",
      "System.AuthorizedDate",
      "System.RevisedDate",
      "System.CommentCount",
      "System.BoardColumn",
      "System.BoardColumnDone",
      "System.AreaLevel1",
      "System.AreaLevel2",
      "System.AreaLevel3",
      "System.IterationLevel1",
      "System.IterationLevel2",
      "System.IterationLevel3",
      "System.IterationLevel4",
      "System.IterationLevel5",
      "System.IterationLevel6",
      "System.ExternalLinkCount",
      "System.HyperLinkCount",
      "System.AttachedFileCount",
      "System.RelatedLinkCount",
      "System.RemoteLinkCount",
      "System.Parent",
    ],
    template: [],
    custom: [],
  },

  skipPrefixes: ["WEF_"],

  renderedFields: {
    system: [
      "System.Title",
      "System.Description",
      "System.State",
      "System.WorkItemType",
      "System.AreaPath",
      "System.IterationPath",
      "System.AssignedTo",
      "System.History",
      "System.Tags",
      "System.CreatedDate",
      "System.CreatedBy",
      "System.ChangedDate",
      "System.ChangedBy",
      "System.Reason",
    ],
    template: [],
    custom: [],
  },

  // Metadata bar fields (inline, pipe-separated)
  metadataFields: [
    { label: "Area", fieldRef: "System.AreaPath", category: "system" },
    { label: "Iteration", fieldRef: "System.IterationPath", category: "system" },
    { label: "Assigned", fieldRef: "System.AssignedTo", category: "system" },
  ],

  contentFields: [
    { label: "Description", fieldRef: "System.Description", category: "system" },
    { label: "History", fieldRef: "System.History", category: "system" },
    { label: "Tags", fieldRef: "System.Tags", category: "system" },
  ],
};
